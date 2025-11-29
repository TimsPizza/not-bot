import { EmotionMetric } from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { renderTemplate } from "../template";
import { TopicStarterPromptContext } from "../types";
import {
  buildEmotionRelationshipHints,
  buildUsernameMappingBlock,
  determineResponseLanguageInstruction,
  formatConversationForContext,
  RESPONSE_EMOTION_METRICS,
} from "../utils";
import { BasePromptAssembler } from "./base";

const OUTPUT_DELTA_BOUND = 8;

export class TopicStarterPromptAssembler extends BasePromptAssembler<TopicStarterPromptContext> {
  protected buildSystemRules(
    context: TopicStarterPromptContext,
  ): ChatCompletionMessageParam {
    const {
      systemPromptTemplate,
      personaDetails,
      personaPrompts,
      contextMessages,
      emotionSnapshots,
    } = context;

    const languageInstruction = determineResponseLanguageInstruction(
      personaPrompts,
      context.languageConfig,
    );

    const botMention = `<@${context.botUserId}>`;
    const nowIso = new Date().toISOString();

    const resolvedPrompt = renderTemplate(systemPromptTemplate, {
      PERSONA_DETAILS: personaDetails,
      LANGUAGE_INSTRUCTION: languageInstruction,
      BOT_MENTION: botMention,
      BOT_USER_ID: context.botUserId,
    });

    const executionContract = [
      "SYSTEM ROLE & OUTPUT CONTRACT:",
      "- You are the Discord topic-starter compiler: consume persona/style/context data and emit only the final JSON response (schema is provided in a later system message).",
      "- Do not role-play or add meta commentary; persona data shapes tone only.",
      "- If tools are required, call them; otherwise jump straight to JSON output. No prefaces, no explanations outside the schema.",
    ].join("\n");

    const hooksGuidance = [
      "Context mining rules for topic starters:",
      "- Mine the recent conversation for hooks (inside jokes, unresolved questions, observations) instead of echoing the last message or your own prior line.",
      "- Avoid parroting the most recent human/bot message; rephrase or pivot to a related but fresh angle.",
      "- Vary who you address; do not repeatedly target the same user without cause.",
      "- If nothing usable is present, keep it concise or gracefully bow out rather than repeating context.",
    ].join("\n");

    const blocks: string[] = [executionContract, resolvedPrompt];

    const usernameMapping = buildUsernameMappingBlock(contextMessages);
    if (usernameMapping) {
      blocks.push(usernameMapping);
    }

    const relationshipHints = buildEmotionRelationshipHints(
      emotionSnapshots ?? [],
      null,
    );
    if (relationshipHints) {
      blocks.push(relationshipHints);
    }

    blocks.push(hooksGuidance);

    blocks.push(
      [
        "You are proactively starting a conversation after a quiet period.",
        `Current time (UTC): ${nowIso}.`,
        "Goals:",
        "- Find a friendly, low-awkwardness topic based on recent channel history.",
        "- You may @ a preferred user if emotion context suggests positive affinity or curiosity toward them.",
        "- Avoid promising to execute tasks; focus on opening a light dialogue (questions, observations, quick tips).",
        "- Keep it concise; 1-2 messages are preferred.",
      ].join("\n"),
    );

    blocks.push(
      [
        "Search language preference:",
        "- Prefer English keywords/queries when invoking external search tools unless the user explicitly requests another language.",
      ].join("\n"),
    );

    return {
      role: "system",
      content: blocks.join("\n\n"),
    };
  }

  protected buildContextMessages(
    context: TopicStarterPromptContext,
  ): ChatCompletionMessageParam[] {
    return formatConversationForContext(context.contextMessages);
  }

  protected buildOutputSchema(
    context: TopicStarterPromptContext,
  ): ChatCompletionMessageParam {
    return {
      role: "system",
      content: buildTopicOutputInstruction(context.emotionDeltaCaps),
    };
  }

  protected getTemperature(): number {
    return 0.9;
  }

  protected getMaxTokens(): number {
    return 4096;
  }
}

function buildTopicOutputInstruction(
  deltaCaps?: Partial<Record<EmotionMetric, number>>,
): string {
  const caps = RESPONSE_EMOTION_METRICS.map((metric) => {
    const cap = deltaCaps?.[metric] ?? OUTPUT_DELTA_BOUND;
    return `${metric}: ±${cap}`;
  }).join(", ");

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
    '    {"sequence": 1, "delay_ms": 0, "content": "..."}',
    "  ],",
    '  "emotion_delta": [',
    '    {"user_id": "...", "metric": "affinity", "delta": 2, "reason": "..."}',
    "  ]",
    "}",
    "```",
    "",
    "Rules:",
    "- The top-level must be an object. NEVER wrap it in an array.",
    "- `messages` MUST be a non-empty array with sequential `sequence` (starting at 1), non-negative `delay_ms`, and textual `content`.",
    "- `emotion_delta` is optional. Each entry requires `user_id`, `metric` (affinity|annoyance|trust|curiosity), and `delta` within allowed caps (" +
      caps +
      ").",
    "- Do NOT emit status-only messages; the content must open a conversation or gracefully bow out if no safe topic exists.",
    "- Output nothing outside the fenced code block.",
  ].join("\n");
}
