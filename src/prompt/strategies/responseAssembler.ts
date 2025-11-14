import { EmotionMetric } from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { renderTemplate } from "../template";
import { ResponsePromptContext } from "../types";
import {
  buildEmotionRelationshipHints,
  buildUsernameMappingBlock,
  determineResponseLanguageInstruction,
  formatConversationForContext,
  formatPendingProactiveMessageBlock,
  formatTargetMessageInstruction,
  RESPONSE_EMOTION_METRICS,
} from "../utils";
import { BasePromptAssembler } from "./base";

const OUTPUT_DELTA_BOUND = 12;
const buildResponseSelectionGuidance = (botMention: string): string =>
  [
    "Response selection guidance:",
    "- Read the entire context to determine which unresolved message deserves attention.",
    `- Favor direct questions, thoughtful remarks, or anything explicitly addressing the bot (mentions of ${botMention} or equivalent).`,
    "- If no message stands out, reply to the latest relevant human message.",
  ].join("\n");

export class ResponsePromptAssembler extends BasePromptAssembler<ResponsePromptContext> {
  protected buildSystemRules(
    context: ResponsePromptContext,
  ): ChatCompletionMessageParam {
    const {
      systemPromptTemplate,
      personaDetails,
      personaPrompts,
      targetMessage,
      targetUserId,
      emotionSnapshots,
      contextMessages,
      pendingProactiveMessages,
    } = context;

    const languageInstruction = determineResponseLanguageInstruction(
      personaPrompts,
      context.languageConfig,
    );

    const botMention = `<@${context.botUserId}>`;

    const resolvedPrompt = renderTemplate(systemPromptTemplate, {
      PERSONA_DETAILS: personaDetails,
      LANGUAGE_INSTRUCTION: languageInstruction,
      BOT_MENTION: botMention,
      BOT_USER_ID: context.botUserId,
    });

    const blocks: string[] = [resolvedPrompt];

    const usernameMapping = buildUsernameMappingBlock(contextMessages);
    if (usernameMapping) {
      blocks.push(usernameMapping);
    }

    const relationshipHints = buildEmotionRelationshipHints(
      emotionSnapshots ?? [],
      targetUserId ?? targetMessage?.authorId ?? null,
    );
    if (relationshipHints) {
      blocks.push(relationshipHints);
    }

    const targetInstruction = formatTargetMessageInstruction(targetMessage);
    if (targetInstruction) {
      blocks.push(targetInstruction);
    }

    blocks.push(buildResponseSelectionGuidance(botMention));

    if (pendingProactiveMessages && pendingProactiveMessages.length > 0) {
      blocks.push(formatPendingProactiveMessageBlock(pendingProactiveMessages));
    }

    return {
      role: "system",
      content: blocks.join("\n\n"),
    };
  }

  protected buildContextMessages(
    context: ResponsePromptContext,
  ): ChatCompletionMessageParam[] {
    return formatConversationForContext(context.contextMessages);
  }

  protected buildOutputSchema(
    context: ResponsePromptContext,
  ): ChatCompletionMessageParam {
    return {
      role: "system",
      content: buildResponseOutputInstruction(context.emotionDeltaCaps),
    };
  }

  protected getTemperature(): number {
    return 1;
  }

  protected getMaxTokens(): number {
    return 1024;
  }
}

function buildResponseOutputInstruction(
  deltaCaps?: Partial<Record<EmotionMetric, number>>,
): string {
  const caps = RESPONSE_EMOTION_METRICS.map((metric) => {
    const cap = deltaCaps?.[metric] ?? OUTPUT_DELTA_BOUND;
    return `${metric}: ±${cap}`;
  }).join(", ");
  const exampleSendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return [
    "Return a strict JSON object with the following structure:",
    "```json",
    "{",
    '  "messages": [',
    '    {"sequence": 1, "delay_ms": 1200, "content": "..."}',
    "  ],",
    '  "emotion_delta": [',
    '    {"user_id": "...", "metric": "affinity", "delta": 3, "reason": "..."}',
    "  ],",
    '  "proactive_messages": [',
    `    {"id": "optional_existing_id", "send_at": "${exampleSendAt}", "content": "...", "reason": "context"}`,
    "  ],",
    '  "cancel_schedule_ids": ["abc123"]',
    "}",
    "```",
    "- `messages` MUST be a non-empty array with sequential `sequence` (starting at 1), non-negative `delay_ms`, and textual `content`.",
    "- `emotion_delta` is optional. Each entry requires `user_id`, `metric` (affinity|annoyance|trust|curiosity), `delta` (integer). Keep deltas within [-12, 12] unless persona caps are stricter (caps: " +
      caps +
      ").",
    "- `proactive_messages` is optional. Each entry must include `send_at` (ISO 8601 UTC) and `content`. Provide an `id` when modifying an existing schedule.",
    "- `cancel_schedule_ids` is optional. Only include IDs that should be cancelled.",
    "- No extra commentary outside the JSON body.",
  ].join("\n");
}
