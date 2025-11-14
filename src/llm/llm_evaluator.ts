// src/llm/llm_evaluator.ts
import configService from "@/config";
import loggerService from "@/logger";
import { PromptBuilder } from "@/prompt";
import type { BuiltPrompt } from "@/prompt";
import {
  AppConfig,
  EmotionDeltaInstruction,
  EmotionMetric,
  EmotionSnapshot,
  LLMEvaluationResult,
  ProactiveMessageDraft,
  ProactiveMessageSummary,
  SimpleMessage,
} from "@/types";
import { callChatCompletionApi } from "./openai_client";
import { parseStructuredJson } from "./structuredJson";
import { retryWithExponentialBackoff } from "@/utils/retry";
import { LLMRetryError } from "@/errors/LLMRetryError";

class LLMEvaluatorService {
  private static instance: LLMEvaluatorService;

  private config: AppConfig | null = null;
  // Remove prompts property, as templates will be passed in

  private constructor() {
    // Only load AppConfig now
    this.config = configService.getConfig();
    loggerService.logger.info("LLMEvaluatorService initialized.");
  }

  /**
   * @description Gets the singleton instance of the LLMEvaluatorService.
   * @returns {LLMEvaluatorService} The singleton instance.
   */
  public static getInstance(): LLMEvaluatorService {
    if (!LLMEvaluatorService.instance) {
      LLMEvaluatorService.instance = new LLMEvaluatorService();
    }
    return LLMEvaluatorService.instance;
  }

  // Removed loadConfigAndPrompts as prompts are no longer loaded here

  /**
   * @description Evaluates a batch of messages using the secondary LLM, considering channel context, responsiveness, and specific persona instructions.
   * @param responsiveness The responsiveness factor for the current context (e.g., server).
   * @param evaluationPromptTemplate The base template for the evaluation prompt.
   * @param personaDetails The specific details/instructions for the current persona.
   * @param batchMessages An array of SimpleMessage objects from the current batch to evaluate.
   * @param channelContextMessages An array of SimpleMessage objects representing the broader channel context.
   * @returns A promise resolving to the LLMEvaluationResult or null if an error occurs.
   */
  public async evaluateMessages(
    responsiveness: number,
    evaluationPromptTemplate: string, // Added template
    personaDetails: string, // Added persona details
    botUserId: string,
    batchMessages: SimpleMessage[],
    channelContextMessages: SimpleMessage[],
    emotionSnapshots?: EmotionSnapshot[],
    pendingProactiveMessages?: ProactiveMessageSummary[],
  ): Promise<LLMEvaluationResult | null> {
    // --- Calculate Effective Threshold ---
    const BASE_RESPONSE_THRESHOLD = 0.35; // Base score needed to consider responding
    // Adjust threshold based on responsiveness: Higher responsiveness = lower threshold
    const effectiveThreshold = Math.max(
      0.01,
      Math.min(1.0, BASE_RESPONSE_THRESHOLD / responsiveness),
    );
    loggerService.logger.debug(
      `Using responsiveness=${responsiveness}, Effective Threshold=${effectiveThreshold.toFixed(2)}`,
    );
    // --------------------------------

    // --------------------------------

    // Validate required configuration for secondary LLM
    // Note: We now check the passed-in template instead of loaded prompts
    if (
      !this.config ||
      !evaluationPromptTemplate || // Check passed template
      !personaDetails || // Ensure persona details are provided
      !this.config.secondaryLlmApiKey ||
      !this.config.secondaryLlmBaseUrl ||
      !this.config.secondaryLlmModel
    ) {
      loggerService.logger.error(
        "Secondary LLM configuration is incomplete. Cannot evaluate messages.",
      );
      return null;
    }

    try {
      const prompt = PromptBuilder.build({
        useCase: "evaluation",
        evaluationPromptTemplate,
        personaDetails,
        botUserId,
        channelContextMessages,
        batchMessages,
        emotionSnapshots,
        pendingProactiveMessages,
      });

      const firstMessageContent = prompt.messages[0]?.content;
      if (
        typeof firstMessageContent === "string" &&
        evaluationPromptTemplate.includes("{{PERSONA_DETAILS}}") &&
        !firstMessageContent.includes(personaDetails)
      ) {
        loggerService.logger.warn(
          "Persona details placeholder '{{PERSONA_DETAILS}}' found in evaluation prompt template, but replacement might have failed.",
        );
      }

      loggerService.logger.debug(
        `Sending ${prompt.messages.length} message parts (system + user with combined context/batch) to LLM Evaluator using effective threshold ${effectiveThreshold.toFixed(2)}.`,
      );

      const rawContent = await this.callEvaluatorModelWithRetry(prompt);

      // --- Parse and Validate JSON Response ---
      const jsonMatch = rawContent.match(/```json\s*([\s\S]+?)\s*```/);
      const parsedJson = parseStructuredJson(
        jsonMatch && jsonMatch[1] ? jsonMatch[1] : rawContent,
        "evaluator",
      );

      if (
        !parsedJson ||
        typeof parsedJson !== "object" ||
        Array.isArray(parsedJson)
      ) {
        throw new Error(
          `Parsed evaluator payload is not an object. Raw: ${rawContent}`,
        );
      }

      const structured = parsedJson as Record<string, any>;

      // Validate structure based on the new LLMEvaluationResult type
      if (
        typeof structured.response_score !== "number" ||
        structured.response_score < 0 ||
        structured.response_score > 1 || // Check range
        typeof structured.reason !== "string"
      ) {
        throw new Error(
          `Parsed JSON from LLM evaluator has incorrect structure or invalid values. Parsed: ${JSON.stringify(structured)}`,
        );
      }

      // Construct the final result object
      const shouldRespondFlag =
        typeof structured.should_respond === "boolean"
          ? structured.should_respond
          : structured.response_score >= effectiveThreshold;

      const result: LLMEvaluationResult = {
        response_score: structured.response_score,
        reason: structured.reason,
        should_respond: shouldRespondFlag,
      };

      const emotionDeltas = parseEmotionDeltaArray(structured.emotion_delta);
      if (emotionDeltas.length > 0) {
        result.emotionDeltas = emotionDeltas;
      }

      const proactiveDeltas = parseProactiveMessagesArray(
        structured.proactive_messages,
      );
      if (proactiveDeltas.length > 0) {
        result.proactiveMessages = proactiveDeltas;
      }

      const cancelScheduleIds = parseCancelIds(structured.cancel_schedule_ids);
      if (cancelScheduleIds.length > 0) {
        result.cancelScheduleIds = cancelScheduleIds;
      }

      loggerService.logger.info(
        `LLM Evaluation result: response_score=${result.response_score.toFixed(2)}, should_respond=${result.should_respond}`,
      );
      return result; // Return the validated and structured result
    } catch (error) {
      if (error instanceof LLMRetryError) {
        throw error;
      }
      loggerService.logger.error(
        `Error during LLM evaluation process: ${error}`,
      );
      return null;
    }
  }

  private async callEvaluatorModelWithRetry(
    prompt: BuiltPrompt,
  ): Promise<string> {
    try {
      return await retryWithExponentialBackoff(
        async () => {
          const rawContent = await callChatCompletionApi(
            "eval",
            this.config!.secondaryLlmModel,
            prompt.messages,
            prompt.temperature,
            prompt.maxTokens,
          );

          if (!rawContent) {
            throw new Error("LLM evaluator returned null response.");
          }

          const trimmed = rawContent.trim();
          if (!trimmed) {
            throw new Error("LLM evaluator returned empty response.");
          }
          return trimmed;
        },
        {
          maxAttempts: EVALUATOR_MAX_ATTEMPTS,
          baseDelayMs: EVALUATOR_BASE_DELAY_MS,
          maxDelayMs: EVALUATOR_MAX_DELAY_MS,
          onRetry: (attempt, error, delayMs) => {
            loggerService.logger.warn(
              {
                attempt,
                delayMs,
                err:
                  error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : "unknown",
              },
              "Evaluator LLM call failed; retrying with backoff.",
            );
          },
        },
      );
    } catch (error) {
      loggerService.logger.error(
        { err: error },
        "Evaluator LLM retries exhausted.",
      );
      throw new LLMRetryError("evaluator", EVALUATOR_MAX_ATTEMPTS, error);
    }
  }
}

const SUPPORTED_EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

const EVALUATOR_MAX_ATTEMPTS = 5;
const EVALUATOR_BASE_DELAY_MS = 10_000;
const EVALUATOR_MAX_DELAY_MS = 60_000;

function parseEmotionDeltaArray(input: unknown): EmotionDeltaInstruction[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const deltas: EmotionDeltaInstruction[] = [];
  input.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const userId = (entry as { user_id?: unknown }).user_id;
    const metric = (entry as { metric?: unknown }).metric;
    const delta = (entry as { delta?: unknown }).delta;
    const reason = (entry as { reason?: unknown }).reason;

    if (typeof userId !== "string" || userId.length === 0) {
      return;
    }
    if (typeof metric !== "string") {
      return;
    }
    if (!SUPPORTED_EMOTION_METRICS.includes(metric as EmotionMetric)) {
      return;
    }
    const deltaNumber = Number(delta);
    if (!Number.isFinite(deltaNumber)) {
      return;
    }

    const instruction: EmotionDeltaInstruction = {
      userId,
      metric: metric as EmotionMetric,
      delta: Math.round(deltaNumber),
    };
    if (typeof reason === "string" && reason.trim().length > 0) {
      instruction.reason = reason.trim();
    }
    deltas.push(instruction);
  });

  return deltas;
}

function parseProactiveMessagesArray(input: unknown): ProactiveMessageDraft[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const drafts: ProactiveMessageDraft[] = [];
  input.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const sendAt = (entry as { send_at?: unknown }).send_at;
    const content = (entry as { content?: unknown }).content;
    if (typeof sendAt !== "string" || typeof content !== "string") {
      return;
    }
    const idValue = (entry as { id?: unknown }).id;
    const reason = (entry as { reason?: unknown }).reason;
    const draft: ProactiveMessageDraft = {
      sendAt,
      content,
    };
    if (typeof idValue === "string" && idValue.trim().length > 0) {
      draft.id = idValue.trim().toLowerCase();
    }
    if (typeof reason === "string" && reason.trim().length > 0) {
      draft.reason = reason.trim();
    }
    drafts.push(draft);
  });

  return drafts;
}

function parseCancelIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((value) =>
      typeof value === "string" ? value.trim().toLowerCase() : null,
    )
    .filter((value): value is string => Boolean(value));
}

// Export the singleton instance directly
const llmEvaluatorService = LLMEvaluatorService.getInstance();
export default llmEvaluatorService;
export { LLMEvaluatorService }; // Export the class type if needed elsewhere
