import {
  EmotionMetric,
  EmotionSnapshot,
  PersonaPrompts,
  SimpleMessage,
  ProactiveMessageSummary,
} from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { renderTemplate } from "./template";
import {
  BuiltPrompt,
  EvaluationPromptContext,
  PromptContext,
  ResponsePromptContext,
  SummaryPromptContext,
} from "./types";

const RESPONSE_LANGUAGE_NAMES: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ru: "Русский",
  pt: "Português",
};

const DEFAULT_LANGUAGE_AUTO_INSTRUCTION =
  "*EXTREMELY IMPORTANT* Automatically detect the language used in the chat context and respond in the corresponding language.";

const DEFAULT_SPECIFIC_LANGUAGE_TEMPLATE =
  "*EXTREMELY IMPORTANT* Please respond primarily in {{LANGUAGE_NAME}}. Even if the context contains messages in other languages, stick to using the specified language. If you cannot use the primary language, use {{FALLBACK_NAME}} as the fallback language.";

const SUMMARY_SYSTEM_MESSAGE =
  "你是一个专业的聊天记录总结助手。请根据用户指定的语言和要求，提供清晰、有用的聊天记录总结。";

const DEFAULT_SUMMARY_TEMPLATE = `请分析以下Discord频道的聊天记录，并提供一个清晰、有用的总结。

**总结要求：**
1. 使用{{target_language}}进行总结
2. 提取主要话题和关键信息
3. 保持客观中性的语调
4. 重点关注有价值的讨论内容
5. 忽略无关的闲聊或系统消息
6. 如果涉及敏感内容，请谨慎处理
7. **重要** 在总结中提到具体用户时，请使用提供的Discord mention格式（如<@123456789>）

**聊天记录：**
{{messages_content}}

请提供一个结构化的总结，包含：
- 📋 主要话题
- 💬 关键讨论点
- 🎯 重要结论或决定
- 📌 需要关注的事项（如有）`;

const RESPONSE_EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

const EMOTION_BUCKET_LABELS: Record<EmotionMetric, string[]> = {
  affinity: ["Extremely distant", "Cool", "Neutral", "Warm", "Clingy"],
  annoyance: ["Calm", "Slightly annoyed", "Annoyed", "Irritated", "Critical"],
  trust: ["No trust", "Doubtful", "Cautious trust", "Trusting", "Fully trusting"],
  curiosity: ["No interest", "Mild interest", "Curious", "Very interested", "Highly engaged"],
};

const DEFAULT_THRESHOLD_FALLBACK: Record<EmotionMetric, number[]> = {
  affinity: [-60, -20, 0, 40],
  annoyance: [-40, -10, 10, 40],
  trust: [-50, -15, 10, 45],
  curiosity: [-30, -5, 20, 50],
};

const OUTPUT_DELTA_BOUND = 12;

export class PromptBuilder {
  public static build(context: PromptContext): BuiltPrompt {
    switch (context.useCase) {
      case "response":
        return buildResponsePrompt(context);
      case "evaluation":
        return buildEvaluationPrompt(context);
      case "summary":
        return buildSummaryPrompt(context);
      default:
        throw new Error(`Unsupported prompt use case: ${(context as any).useCase}`);
    }
  }
}

function buildResponsePrompt(context: ResponsePromptContext): BuiltPrompt {
  const {
    systemPromptTemplate,
    personaDetails,
    personaPrompts,
    contextMessages,
    languageConfig,
    targetMessage,
    targetUserId,
    emotionSnapshots,
    emotionDeltaCaps,
    pendingProactiveMessages,
  } = context;

  const languageInstruction = determineResponseLanguageInstruction(
    personaPrompts,
    languageConfig,
  );

  const resolvedSystemPrompt = renderTemplate(systemPromptTemplate, {
    PERSONA_DETAILS: personaDetails,
    LANGUAGE_INSTRUCTION: languageInstruction,
  });

  const messages = formatMessagesForChat(contextMessages, resolvedSystemPrompt);

  if (targetMessage) {
    messages.push({
      role: "system",
      content: `Please pay special attention to replying to ${targetMessage.authorUsername}: ${targetMessage.content}`,
    });
  }

  if (emotionSnapshots && emotionSnapshots.length > 0) {
    messages.push({
      role: "system",
      content: buildEmotionGuidanceMessage(
        emotionSnapshots,
        targetUserId ?? targetMessage?.authorId ?? null,
      ),
    });
  }

  if (pendingProactiveMessages && pendingProactiveMessages.length > 0) {
    messages.push({
      role: "system",
      content: buildPendingProactiveMessageBlock(pendingProactiveMessages),
    });
  }

  messages.push({
    role: "system",
    content: buildResponseOutputInstruction(emotionDeltaCaps),
  });

  return {
    messages,
    temperature: 1,
    maxTokens: 1024,
  };
}

function determineResponseLanguageInstruction(
  personaPrompts: PersonaPrompts | null,
  languageConfig?: { primary: string; fallback: string; autoDetect: boolean },
): string {
  if (!languageConfig) {
    return DEFAULT_LANGUAGE_AUTO_INSTRUCTION;
  }

  const languageTemplates = personaPrompts?.language_instructions;

  if (languageConfig.primary === "auto" && languageConfig.autoDetect) {
    return (
      languageTemplates?.auto_detect ?? DEFAULT_LANGUAGE_AUTO_INSTRUCTION
    );
  }

  if (languageConfig.primary !== "auto") {
    const languageName =
      RESPONSE_LANGUAGE_NAMES[languageConfig.primary] || languageConfig.primary;
    const fallbackName =
      RESPONSE_LANGUAGE_NAMES[languageConfig.fallback] ||
      languageConfig.fallback;

    const template =
      languageTemplates?.specific_language ?? DEFAULT_SPECIFIC_LANGUAGE_TEMPLATE;

    return renderTemplate(template, {
      LANGUAGE_NAME: languageName,
      FALLBACK_NAME: fallbackName,
    });
  }

  return DEFAULT_LANGUAGE_AUTO_INSTRUCTION;
}

function formatMessagesForChat(
  messages: SimpleMessage[],
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  const formatted: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  messages.forEach((msg) => {
    if (msg.isBot) {
      formatted.push({ role: "assistant", content: msg.content });
    } else {
      formatted.push({
        role: "user",
        content: `${msg.authorUsername}：${msg.content}`,
      });
    }
  });

  return formatted;
}

function buildEmotionGuidanceMessage(
  snapshots: EmotionSnapshot[],
  focusUserId: string | null,
): string {
  const lines: string[] = [];
  lines.push(
    "Emotion reference (range -100 to 100; positive = warmer/closer, negative = colder/annoyed):",
  );

  snapshots.forEach((snapshot) => {
    lines.push(formatEmotionSnapshot(snapshot, focusUserId));
  });

  lines.push(
    "Adjust your tone and content based on these states. If you propose emotion deltas, keep them reasonable and consistent with the persona.",
  );
  return lines.join("\n");
}

function buildPendingProactiveMessageBlock(
  messages: ProactiveMessageSummary[],
): string {
  const lines: string[] = [];
  lines.push(
    "Scheduled proactive messages: review and decide whether to keep or cancel the following:",
  );
  messages.forEach((pending, index) => {
    lines.push(
      `${index + 1}. ID=${pending.id} | window=${new Date(pending.scheduledAt).toISOString()} | status=${pending.status} | preview=${pending.contentPreview}`,
    );
  });
  lines.push(
    "If any entry is no longer appropriate, add its ID to `cancel_schedule_ids` in your JSON output. To schedule new proactive content, add items to `proactive_messages`.",
  );
  return lines.join("\n");
}

function buildEvaluationEmotionMessage(
  snapshots: EmotionSnapshot[],
): string {
  const lines: string[] = [];
  lines.push(
    "Additional emotion context: prioritise users with higher affinity/trust and lower annoyance.",
  );
  snapshots.forEach((snapshot) => {
    lines.push(formatEmotionSnapshot(snapshot, null));
  });
  lines.push(
    "If you recommend replying to someone, you may include small `emotion_delta` adjustments (each within ±12) in the result.",
  );
  return lines.join("\n");
}

function buildResponseOutputInstruction(
  deltaCaps?: Partial<Record<EmotionMetric, number>>,
): string {
  const capText = RESPONSE_EMOTION_METRICS.map((metric) => {
    const cap = deltaCaps?.[metric] ?? OUTPUT_DELTA_BOUND;
    return `${metric}: ±${cap}`;
  }).join(", ");
  const exampleSendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return [
    "You must return a strict JSON object with the following structure:",
    "```json",
    '{',
    '  "messages": [',
    '    {"sequence": 1, "delay_ms": 1200, "content": "..."}',
    "  ],",
    '  "emotion_delta": [',
    '    {"user_id": "...", "metric": "affinity", "delta": 3, "reason": "..."}',
    "  ],",
    '  "proactive_messages": [',
    `    {"id": "opt_existing_id", "send_at": "${exampleSendAt}", "content": "...", "reason": "context"}`,
    "  ],",
    '  "cancel_schedule_ids": ["abc12"]',
    "}",
    "```",
    "- `messages` is required. It must be a non-empty array; each item needs `sequence` (integer starting at 1), `delay_ms` (non-negative integer), and `content` (string).",
    "- `emotion_delta` is optional. Only include entries when you need to adjust emotions. Each entry requires `user_id`, `metric` (affinity|annoyance|trust|curiosity), and `delta` (integer). Keep each delta within [-12, 12]; avoid excessive adjustments. Persona-recommended max per update: " +
      capText +
      ".",
    "- `proactive_messages` is optional. Include entries to schedule new proactive sends or update existing ones (provide `id` when modifying). Each entry must include `send_at` (ISO 8601 UTC timestamp) and `content`, plus optional `reason`.",
    "- `cancel_schedule_ids` is optional. Provide an array of existing proactive IDs that should be cancelled.",
    "- Do not add any extra text outside the JSON object.",
  ].join("\n");
}

function formatEmotionSnapshot(
  snapshot: EmotionSnapshot,
  focusUserId: string | null,
): string {
  const isFocus = focusUserId && snapshot.targetUserId === focusUserId;
  const prefix = isFocus ? "★ Focus Target" : "- User";
  const header = `${prefix} <@${snapshot.targetUserId}>`;
  const metricLines = RESPONSE_EMOTION_METRICS.map((metric) => {
    const value = snapshot.state.metrics[metric];
    const thresholds =
      snapshot.personaThresholds?.[metric] ??
      DEFAULT_THRESHOLD_FALLBACK[metric];
    return `  · ${metric}: ${value} (${describeEmotionValue(value, thresholds, metric)})`;
  });
  return [header, ...metricLines].join("\n");
}

function describeEmotionValue(
  value: number,
  thresholds: number[],
  metric: EmotionMetric,
): string {
  const labels = EMOTION_BUCKET_LABELS[metric] || EMOTION_BUCKET_LABELS.affinity;
  const bucket = resolveBucketFromThresholds(value, thresholds);
  const index = Math.min(bucket, labels.length - 1);
  const candidate = labels[index];
  return candidate ?? labels[labels.length - 1] ?? "Neutral";
}

function resolveBucketFromThresholds(value: number, thresholds: number[]): number {
  const sorted = [...thresholds].sort((a, b) => a - b);
  let bucket = sorted.length;
  for (let i = 0; i < sorted.length; i += 1) {
    if (value < sorted[i]!) {
      bucket = i;
      break;
    }
  }
  return bucket;
}

function buildEvaluationPrompt(context: EvaluationPromptContext): BuiltPrompt {
  const {
    evaluationPromptTemplate,
    personaDetails,
    channelContextMessages,
    batchMessages,
    contextLookback = 10,
    emotionSnapshots,
    pendingProactiveMessages,
  } = context;

  const resolvedPrompt = renderTemplate(evaluationPromptTemplate, {
    PERSONA_DETAILS: personaDetails,
  });

  const messagesToEvaluate = buildMessagesForEvaluation(
    channelContextMessages,
    batchMessages,
    contextLookback,
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: resolvedPrompt },
    {
      role: "user",
      content: JSON.stringify(messagesToEvaluate, null, 2),
    },
  ];

  if (emotionSnapshots && emotionSnapshots.length > 0) {
    messages.push({
      role: "system",
      content: buildEvaluationEmotionMessage(emotionSnapshots),
    });
  }

  if (pendingProactiveMessages && pendingProactiveMessages.length > 0) {
    messages.push({
      role: "system",
      content: buildPendingProactiveMessageBlock(pendingProactiveMessages),
    });
  }

  messages.push({
    role: "system",
    content:
      "Return a strict JSON object with keys `response_score` (0.0-1.0 float), `target_message_id` (string or null), `reason` (string), `should_respond` (boolean), and optional arrays `emotion_delta`, `proactive_messages`, plus optional `cancel_schedule_ids`. `emotion_delta` entries must include `user_id` (string), `metric` (affinity|annoyance|trust|curiosity), `delta` (integer within [-12,12]), and optional `reason`. `proactive_messages` entries may include `id` (existing scheduled id or omit for new), `send_at` (ISO 8601 UTC timestamp), `content`, and optional `reason`. Use `cancel_schedule_ids` to list any scheduled proactive ids that should be removed. Omit arrays when not needed.",
  });

  return {
    messages,
    temperature: 0.2,
    maxTokens: 1024,
  };
}

function buildMessagesForEvaluation(
  contextMessages: SimpleMessage[],
  batchMessages: SimpleMessage[],
  lookback: number,
): Array<{
  id: string;
  author: string;
  content: string;
  timestamp: string;
  hasBeenRepliedTo: boolean;
}> {
  const recentContext = contextMessages.slice(-lookback);
  const combined = [...recentContext, ...batchMessages];

  return combined.map((msg) => ({
    id: msg.id,
    author: msg.authorUsername,
    content: msg.content,
    timestamp: new Date(msg.timestamp).toISOString(),
    hasBeenRepliedTo: msg.respondedTo || false,
  }));
}

function buildSummaryPrompt(context: SummaryPromptContext): BuiltPrompt {
  const {
    summaryPromptTemplate,
    personaPrompts,
    summaryConfig,
    formattedMessages,
    userMappingText,
    messageBatch,
    targetLanguageName,
    primaryLanguageCode,
    timeRange,
  } = context;

  const summaryPrompts = personaPrompts?.summary_prompts;
  const template =
    summaryPromptTemplate ??
    summaryPrompts?.basic_summary ??
    DEFAULT_SUMMARY_TEMPLATE;

  const directionKey = summaryConfig.direction ?? "forward";
  const directionInstruction =
    summaryPrompts?.direction_instructions?.[directionKey] ??
    getSummaryDirectionDescription(directionKey);

  const languageStyle =
    (summaryPrompts?.summary_styles || {})[primaryLanguageCode] ?? "";

  const messagesContentParts: string[] = [];
  if (userMappingText) {
    messagesContentParts.push(
      `**用户映射表（用于在总结中正确引用用户）：**\n${userMappingText}`,
    );
  }
  messagesContentParts.push(formattedMessages);
  const messagesContent = messagesContentParts.join("\n\n");

  const renderedPrompt = renderTemplate(template, {
    target_language: targetLanguageName,
    summary_direction: directionInstruction,
    messages_content: messagesContent,
    message_count: messageBatch.totalCount,
    time_range: timeRange,
    language_instruction: languageStyle,
  });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SUMMARY_SYSTEM_MESSAGE },
    { role: "user", content: renderedPrompt },
  ];

  return {
    messages,
    temperature: 0.95,
    maxTokens: 1500,
  };
}

function getSummaryDirectionDescription(direction: string): string {
  switch (direction) {
    case "forward":
      return "Summarize the conversation that followed the specified message";
    case "backward":
      return "Summarize the conversation that preceded the specified message";
    case "around":
      return "Summarize the complete discussion process around the specified message";
    default:
      return direction;
  }
}
