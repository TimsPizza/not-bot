import loggerService from "@/logger";
import {
  EmotionMetric,
  EmotionSnapshot,
  PersonaPrompts,
  ProactiveMessageSummary,
  SimpleMessage,
} from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { renderTemplate } from "./template";

export const RESPONSE_LANGUAGE_NAMES: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  ru: "Russian",
  pt: "Portuguese",
};

const DEFAULT_LANGUAGE_AUTO_INSTRUCTION =
  "**IMPORTANT** Detect the primary language of the chat history automatically and reply in that language.";

const DEFAULT_SPECIFIC_LANGUAGE_TEMPLATE =
  "**IMPORTANT** Respond in {{LANGUAGE_NAME}}. Even if some context is written in another language, keep using the specified language. If {{LANGUAGE_NAME}} is not possible, fall back to {{FALLBACK_NAME}}.";

const EMOTION_BUCKET_LABELS: Record<EmotionMetric, string[]> = {
  affinity: ["Extremely distant", "Cool", "Neutral", "Warm", "Clingy"],
  annoyance: ["Calm", "Slightly annoyed", "Annoyed", "Irritated", "Critical"],
  trust: [
    "No trust",
    "Doubtful",
    "Cautious trust",
    "Trusting",
    "Fully trusting",
  ],
  curiosity: [
    "No interest",
    "Mild interest",
    "Curious",
    "Very interested",
    "Highly engaged",
  ],
};

const DEFAULT_THRESHOLD_FALLBACK: Record<EmotionMetric, number[]> = {
  affinity: [-60, -20, 0, 40],
  annoyance: [-40, -10, 10, 40],
  trust: [-50, -15, 10, 45],
  curiosity: [-30, -5, 20, 50],
};

export const RESPONSE_EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

export function determineResponseLanguageInstruction(
  personaPrompts: PersonaPrompts | null,
  languageConfig?: { primary: string; fallback: string; autoDetect: boolean },
): string {
  if (!languageConfig) {
    return DEFAULT_LANGUAGE_AUTO_INSTRUCTION;
  }

  const languageTemplates = personaPrompts?.language_instructions;

  if (languageConfig.primary === "auto" && languageConfig.autoDetect) {
    return languageTemplates?.auto_detect ?? DEFAULT_LANGUAGE_AUTO_INSTRUCTION;
  }

  if (languageConfig.primary !== "auto") {
    const languageName =
      RESPONSE_LANGUAGE_NAMES[languageConfig.primary] || languageConfig.primary;
    const fallbackName =
      RESPONSE_LANGUAGE_NAMES[languageConfig.fallback] ||
      languageConfig.fallback;

    const template =
      languageTemplates?.specific_language ??
      DEFAULT_SPECIFIC_LANGUAGE_TEMPLATE;

    return renderTemplate(template, {
      LANGUAGE_NAME: languageName,
      FALLBACK_NAME: fallbackName,
    });
  }

  return DEFAULT_LANGUAGE_AUTO_INSTRUCTION;
}

export function buildUsernameMappingBlock(
  messages: SimpleMessage[],
): string | null {
  const seen = new Map<string, string>();
  messages.forEach((msg) => {
    if (!seen.has(msg.authorId)) {
      seen.set(msg.authorId, msg.authorUsername);
    }
  });

  if (seen.size === 0) {
    return null;
  }

  const lines: string[] = ["User mention directory:"];
  for (const [id, username] of seen.entries()) {
    lines.push(`- <@${id}> → ${username}`);
  }

  lines.push(
    "When mentioning any participant, always use the <@user_id> form shown above.",
  );
  const final = lines.join("\n");
  loggerService.logger.debug(
    `Creating user mapping text for summary: ${JSON.stringify(final)}`,
  );
  return final;
}

export function buildEmotionRelationshipHints(
  snapshots: EmotionSnapshot[],
  focusUserId?: string | null,
): string | null {
  if (!snapshots || snapshots.length === 0) {
    return null;
  }

  const lines: string[] = ["Relationship hints:"];

  snapshots.forEach((snapshot) => {
    const prefix =
      focusUserId && snapshot.targetUserId === focusUserId
        ? "* Priority target"
        : "- Participant";
    lines.push(
      `${prefix}: <@${snapshot.targetUserId}> — ${summarizeSnapshotTone(snapshot)}`,
    );
  });

  lines.push(
    "Use these cues to adjust tone. Do not expose numeric metrics directly.",
  );
  return lines.join("\n");
}

function summarizeSnapshotTone(snapshot: EmotionSnapshot): string {
  const pieces: string[] = [];

  RESPONSE_EMOTION_METRICS.forEach((metric) => {
    const thresholds =
      snapshot.personaThresholds?.[metric] ??
      DEFAULT_THRESHOLD_FALLBACK[metric];
    const label = describeEmotionValue(
      snapshot.state.metrics[metric],
      thresholds,
      metric,
    ).toLowerCase();

    switch (metric) {
      case "affinity":
        pieces.push(`affinity feels ${label}`);
        break;
      case "annoyance":
        pieces.push(`annoyance is ${label}`);
        break;
      case "trust":
        pieces.push(`trust level is ${label}`);
        break;
      case "curiosity":
        pieces.push(`curiosity is ${label}`);
        break;
      default:
        pieces.push(`${metric} is ${label}`);
        break;
    }
  });

  return pieces.join(", ") || "overall neutral";
}

export function describeEmotionValue(
  value: number,
  thresholds: number[],
  metric: EmotionMetric,
): string {
  const labels =
    EMOTION_BUCKET_LABELS[metric] || EMOTION_BUCKET_LABELS.affinity;
  const bucket = resolveBucketFromThresholds(value, thresholds);
  const index = Math.min(bucket, labels.length - 1);
  const candidate = labels[index];
  return candidate ?? labels[labels.length - 1] ?? "Neutral";
}

function resolveBucketFromThresholds(
  value: number,
  thresholds: number[],
): number {
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

export function formatPendingProactiveMessageBlock(
  messages: ProactiveMessageSummary[],
): string {
  const lines: string[] = [
    "Pending proactive sends (review and cancel if obsolete):",
  ];

  messages.forEach((pending, index) => {
    lines.push(
      `${index + 1}. id=${pending.id} window=${new Date(
        pending.scheduledAt,
      ).toISOString()} status=${pending.status} preview=${pending.contentPreview}`,
    );
  });

  lines.push(
    "Add any ids that should be cancelled to `cancel_schedule_ids` in the output JSON.",
  );
  return lines.join("\n");
}

export function formatTargetMessageInstruction(
  targetMessage?: SimpleMessage,
): string | null {
  if (!targetMessage) {
    return null;
  }

  const preview =
    targetMessage.content.length > 220
      ? `${targetMessage.content.slice(0, 220)}…`
      : targetMessage.content;
  return [
    "Primary reply target:",
    `- author: ${targetMessage.authorUsername} <@${targetMessage.authorId}>`,
    `- message_id: ${targetMessage.id}`,
    `- excerpt: ${preview}`,
  ].join("\n");
}

export function formatConversationForContext(
  messages: SimpleMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.isBot) {
      return {
        role: "assistant" as const,
        name: sanitizeName(msg.authorUsername),
        content: msg.content,
      };
    }

    return {
      role: "user" as const,
      name: sanitizeName(msg.authorUsername),
      content: msg.content,
    };
  });
}

function sanitizeName(name: string): string {
  // Trim and normalize unicode
  let out = name.normalize("NFKC").trim();

  // trim space and control characters
  out = out.replace(/\s+/g, "_");
  out = out.replace(/[\u0000-\u001F\u007F]/g, "");

  // keep unicode, remove characters that may break JSON or cause weird structures
  out = out.replace(/[{}\[\]",:]/g, "_");

  // lenth limit
  out = out.slice(0, 48);

  // empty fallback
  if (!out) return "user";

  return out;
}

export function formatEvaluationMessagesAsText(
  contextMessages: SimpleMessage[],
  batchMessages: SimpleMessage[],
  lookback: number,
): string {
  const recentContext = contextMessages.slice(-lookback);
  const combined = [...recentContext, ...batchMessages];
  const seen = new Set<string>();

  const blocks = combined
    .filter((msg) => {
      if (seen.has(msg.id)) {
        return false;
      }
      seen.add(msg.id);
      return true;
    })
    .map((msg) => {
      const lines = [
        `message_id: ${msg.id}`,
        `author: ${msg.authorUsername} <@${msg.authorId}>`,
        `timestamp: ${new Date(msg.timestamp).toISOString()}`,
        `was_replied: ${msg.hasBeenRepliedTo ?? msg.respondedTo ?? false}`,
        "content: |",
        `  ${msg.content.replace(/\n/g, "\n  ")}`,
      ];
      return lines.join("\n");
    });

  return blocks.join("\n---\n");
}
