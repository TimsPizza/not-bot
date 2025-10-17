import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  BuiltPrompt,
  PromptContext,
  ResponsePromptContext,
  EvaluationPromptContext,
  SummaryPromptContext,
} from "./types";
import { renderTemplate } from "./template";
import { SimpleMessage, PersonaPrompts } from "@/types";

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
      content: `请特别注意回应用户 ${targetMessage.authorUsername} 的消息：${targetMessage.content}`,
    });
  }

  messages.push({
    role: "system",
    content:
      'You must answer using only a JSON array. Each element must include `sequence` (integer starting at 1), `delay_ms` (non-negative integer), and `content` (string). Example: [{"sequence":1,"delay_ms":1200,"content":"Hello!"}]. Do NOT include any text before or after the JSON array. Also you should choose proper `delay_ms` for each message to act like a human is typing',
  });

  return {
    messages,
    temperature: 1,
    maxTokens: 300,
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

function buildEvaluationPrompt(context: EvaluationPromptContext): BuiltPrompt {
  const {
    evaluationPromptTemplate,
    personaDetails,
    channelContextMessages,
    batchMessages,
    contextLookback = 10,
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

  return {
    messages,
    temperature: 0.2,
    maxTokens: 200,
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
