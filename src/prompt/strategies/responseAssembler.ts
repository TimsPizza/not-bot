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

    const nowDateString = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

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
    blocks.push(
      [
        "** TIME SENSITIVITY PROTOCOL **",
        `- Today is ${nowDateString}.`,
        "- When searching for 'latest', 'recent', or 'news', you MUST explicitly include the current Year and Month in your search query keywords.",
        "- Example: If user asks for 'recently news', do include the date given above in your search query.",
        "- Relative time references (e.g., 'last week') must be converted to specific dates (e.g., 'Nov 20 - Nov 27') before calling any tools.",
      ].join("\n"),
    );

    blocks.push(
      [
        "** CRITICAL TOOL USE GUIDELINES **",
        "1. **No Pending States**: There is no 'pending' or 'processing' state between turns. A task is either completed with a `[tool_result]` visible in the context, or it has failed.",
        "2. **The 'Silence is Failure' Rule**: If you see a promise to act in the history but no tool output follows, you MUST assume the previous execution crashed. Do not assume it is still running.",
        "3. **Immediate Action**: When asked about a missing result, do not explain or stall. Your ONLY valid response is to generate a new tool call to retry the operation.",
        "4. **Anti-Hallucination**: Strictly FORBIDDEN to reply with anything like 'I am working on it' or 'Hold on'. If the data is not in the context, you do not have it. Get it now.",
      ].join("\n"),
    );

    blocks.push(
      [
        "Search language preference:",
        "- Prefer English keywords/queries when invoking external search tools unless the user explicitly requests another language.",
      ].join("\n"),
    );

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
    return 1.1;
  }

  protected getMaxTokens(): number {
    return 8192;
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
    "You MUST output exactly one JSON object, wrapped in a single fenced code block using ```json ... ```.",
    "The top-level value MUST be a JSON object, NOT an array.",
    "Do NOT include any text before or after the code block.",
    "Do NOT include multiple code blocks.",
    "",
    "The JSON structure MUST follow this exact schema:",
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
    "",
    "Rules:",
    "- The top-level must be an object. NEVER wrap it in an array.",
    "- `messages` MUST be a non-empty array with sequential `sequence` (starting at 1), non-negative `delay_ms`, and textual `content`.",
    "- `emotion_delta` is optional. Each entry requires `user_id`, `metric` (affinity|annoyance|trust|curiosity), and `delta` within [-12, 12], unless caps are stricter (" +
      caps +
      ").",
    "- `proactive_messages` is optional. Each entry must include `send_at` (ISO 8601 UTC) and `content`; include `id` if modifying an existing schedule.",
    "- `cancel_schedule_ids` is optional. Only include IDs that should be cancelled.",
    "- Do NOT emit status-only messages like “searching” or “already doing it”; the first message must contain either the actual answer/result (after running tools) or a brief failure note with what to change.",
    "- Output nothing outside the fenced code block.",
  ].join("\n");
}
