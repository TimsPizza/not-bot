import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { renderTemplate } from "../template";
import { EvaluationPromptContext } from "../types";
import {
  buildEmotionRelationshipHints,
  formatEvaluationMessagesAsText,
  formatPendingProactiveMessageBlock,
} from "../utils";
import { BasePromptAssembler } from "./base";

const DEFAULT_EVALUATION_PROMPT = (botMention: string): string =>
  [
    "You are a message evaluation assistant.",
    "Goal: determine whether the bot should respond to recent Discord messages.",
    "Rules:",
    "1. Ignore anything already replied to or written by the bot.",
    `2. Prioritize direct questions, explicit use of the exact ${botMention}, which is the bot mention, or clearly interesting remarks.`,
    "3. Skip fluff, spam, or content that lacks context.",
    "4. Only advise responding when the conversation benefits from it.",
  ].join("\n");

export class EvaluationPromptAssembler extends BasePromptAssembler<EvaluationPromptContext> {
  protected buildSystemRules(
    context: EvaluationPromptContext,
  ): ChatCompletionMessageParam {
    const {
      evaluationPromptTemplate,
      emotionSnapshots,
      pendingProactiveMessages,
      botUserId,
    } = context;

    const botMention = `<@${botUserId}>`;

    const promptText = evaluationPromptTemplate
      ? renderTemplate(evaluationPromptTemplate, {
          BOT_MENTION: botMention,
          BOT_USER_ID: botUserId,
        })
      : DEFAULT_EVALUATION_PROMPT(botMention);

    const blocks: string[] = [promptText];
    blocks.push(
      `Only treat ${botMention} (and literal references to the bot's own username) as mentions of the bot. Ignore other mentions entirely.`,
    );

    const relationshipHints = buildEmotionRelationshipHints(
      emotionSnapshots ?? [],
      null,
    );
    if (relationshipHints) {
      blocks.push(relationshipHints);
    }

    if (pendingProactiveMessages && pendingProactiveMessages.length > 0) {
      blocks.push(formatPendingProactiveMessageBlock(pendingProactiveMessages));
    }

    return {
      role: "system",
      content: blocks.join("\n\n"),
    };
  }

  protected buildContextMessages(
    context: EvaluationPromptContext,
  ): ChatCompletionMessageParam[] {
    const {
      channelContextMessages,
      batchMessages,
      contextLookback = 10,
    } = context;
    const content = formatEvaluationMessagesAsText(
      channelContextMessages,
      batchMessages,
      contextLookback,
    );
    return [
      {
        role: "user",
        name: "message_log",
        content,
      },
    ];
  }

  protected buildOutputSchema(): ChatCompletionMessageParam {
    return {
      role: "system",
      content:
        "Return a strict JSON object with keys `response_score` (float 0.0-1.0), `reason` (string), `should_respond` (boolean), optional `emotion_delta` array, and optional `cancel_schedule_ids` array. `emotion_delta` entries require `user_id`, `metric` (affinity|annoyance|trust|curiosity), `delta` (integer within [-12,12]), plus optional `reason`. Include `cancel_schedule_ids` only when scheduled proactive items must be cancelled; do NOT create or edit proactive messages here. Do not add text outside the JSON. Do not wrap the JSON in an array. Always keep the ```json ... ``` fencing.",
    };
  }

  protected getTemperature(): number {
    return 0.8;
  }

  protected getMaxTokens(): number {
    return 4096;
  }
}
