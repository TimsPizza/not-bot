// src/llm/responder.ts
import configService from "@/config";
import contextManagerService from "@/context";
import loggerService from "@/logger";
import {
  AppConfig,
  SimpleMessage,
  StructuredResponseSegment,
  ResponderResult,
  EmotionDeltaInstruction,
  EmotionMetric,
  EmotionSnapshot,
  ProactiveMessageDraft,
  ProactiveMessageSummary,
} from "@/types";
import { callChatCompletionApi } from "./openai_client";
import { jsonrepair } from "jsonrepair";
import { PromptBuilder } from "@/prompt";

const SUPPORTED_EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

class ResponderService {
  private static instance: ResponderService;

  private config: AppConfig | null = null;
  // Remove prompts property

  private constructor() {
    // Only load AppConfig
    this.config = configService.getConfig();
    loggerService.logger.info("ResponderService initialized.");
  }

  /**
   * @description Gets the singleton instance of the ResponderService.
   * @returns {ResponderService} The singleton instance.
   */
  public static getInstance(): ResponderService {
    if (!ResponderService.instance) {
      ResponderService.instance = new ResponderService();
    }
    return ResponderService.instance;
  }

  // Removed loadConfigAndPrompts

  /**
   * @description Generates a response using the primary LLM based on channel context and persona.
   * @param channelId The ID of the channel to generate a response for.
   * @param systemPromptTemplate The base template for the system prompt.
   * @param personaDetails The specific details/instructions for the current persona.
   * @param targetMessage Optional: The specific message being responded to (if determined by evaluator).
   * @returns A promise resolving to the generated response string or null.
   */
  public async generateResponse(
    channelId: string,
    systemPromptTemplate: string,
    personaDetails: string,
    languageConfig?: { primary: string; fallback: string; autoDetect: boolean },
    targetMessage?: SimpleMessage,
    emotionContext?: {
      targetUserId?: string;
      snapshots?: EmotionSnapshot[];
      deltaCaps?: Partial<Record<EmotionMetric, number>>;
      pendingProactiveMessages?: ProactiveMessageSummary[];
    },
  ): Promise<ResponderResult | null> {
    // Validate required configuration for primary LLM
    if (
      !this.config ||
      !systemPromptTemplate || // Check passed template
      !personaDetails || // Check passed details
      !this.config.primaryLlmApiKey ||
      !this.config.primaryLlmBaseUrl ||
      !this.config.primaryLlmModel
    ) {
      const missingConfigs = [];
      if (!this.config) missingConfigs.push("AppConfig");
      if (!systemPromptTemplate) missingConfigs.push("systemPromptTemplate");
      if (!personaDetails) missingConfigs.push("personaDetails");
      if (!this.config?.primaryLlmApiKey)
        missingConfigs.push("primaryLlmApiKey");
      if (!this.config?.primaryLlmBaseUrl)
        missingConfigs.push("primaryLlmBaseUrl");
      if (!this.config?.primaryLlmModel) missingConfigs.push("primaryLlmModel");
      if (missingConfigs.length > 0) {
        loggerService.logger.error(
          `Secondary LLM configuration is incomplete. Missing: ${missingConfigs.join(", ")}`,
        );
        return null;
      }
    }

    // Get context for the channel
    const context = contextManagerService.getContext(channelId);
    const contextMessages = context?.messages || [];

    if (contextMessages.length === 0) {
      loggerService.logger.warn(
        `No context found for channel ${channelId}. Cannot generate response.`,
      );
      return null; // Cannot respond without context
    }

    try {
      const personaPrompts = configService.getPersonaPrompts();
      const prompt = PromptBuilder.build({
        useCase: "response",
        systemPromptTemplate,
        personaDetails,
        personaPrompts,
        contextMessages,
        languageConfig,
        targetMessage,
        targetUserId: emotionContext?.targetUserId,
        emotionSnapshots: emotionContext?.snapshots,
        emotionDeltaCaps: emotionContext?.deltaCaps,
        pendingProactiveMessages: emotionContext?.pendingProactiveMessages,
      });

      // Call the API using the main client (for response generation)
      // Use non-null assertion (!) as config is validated at the start of the method
      const rawResponse = await callChatCompletionApi(
        "main",
        this.config!.primaryLlmModel,
        prompt.messages,
        prompt.temperature,
        prompt.maxTokens,
      );

      if (!rawResponse) {
        return null;
      }

      const cleanedText = rawResponse.trim();
      if (cleanedText.length === 0) {
        loggerService.logger.warn("LLM generated an empty response.");
        return null;
      }
      if (cleanedText.toLowerCase().includes("as an ai language model")) {
        loggerService.logger.warn(
          "LLM response contained boilerplate AI disclaimer. Discarding.",
        );
        return null;
      }

      const responderOutput = this.parseResponderOutput(cleanedText);
      if (!responderOutput) {
        loggerService.logger.warn(
          "Failed to parse structured response from LLM. Falling back to single message.",
        );
        return {
          segments: [
            {
              sequence: 1,
              delayMs: 0,
              content: cleanedText,
            },
          ],
        };
      }

      return responderOutput;
    } catch (error) {
      loggerService.logger.error({ err: error }, "Error generating response");
      return null;
    }
  }

  private parseResponderOutput(raw: string): ResponderResult | null {
    if (!raw) {
      return null;
    }

    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?/i, "");
      cleaned = cleaned.replace(/```$/i, "");
    }
    // fuck it, jsonrepair cannot cleanup this
    cleaned = cleaned.replace("<｜begin▁of▁sentence｜>", "");

    let parsed: unknown;
    try {
      // maybe need to remove BOS
      cleaned = jsonrepair(cleaned);
      parsed = JSON.parse(cleaned);
    } catch (error) {
      loggerService.logger.warn(
        {
          err: error instanceof Error ? error.message : error,
        },
        "LLM response is not valid JSON for structured segments.",
      );
      return null;
    }

    let segmentsSource: unknown;
    let deltaSource: unknown;
    let proactiveSource: unknown;
    let cancelSource: unknown;

    if (Array.isArray(parsed)) {
      segmentsSource = parsed;
    } else if (parsed && typeof parsed === "object") {
      segmentsSource = (parsed as { messages?: unknown }).messages;
      deltaSource = (parsed as { emotion_delta?: unknown }).emotion_delta;
      proactiveSource = (parsed as { proactive_messages?: unknown }).proactive_messages;
      cancelSource = (parsed as { cancel_schedule_ids?: unknown }).cancel_schedule_ids;
    }

    if (!Array.isArray(segmentsSource)) {
      loggerService.logger.warn(
        "Structured response JSON did not contain an array of messages.",
      );
      return null;
    }

    const segments = this.normalizeSegments(segmentsSource);
    if (!segments.length) {
      return null;
    }

    const emotionDeltas = this.normalizeEmotionDelta(deltaSource);
    const proactiveMessages = this.normalizeProactiveMessages(proactiveSource);
    const cancelScheduleIds = this.normalizeCancelIds(cancelSource);

    return {
      segments,
      emotionDeltas: emotionDeltas.length > 0 ? emotionDeltas : undefined,
      proactiveMessages:
        proactiveMessages.length > 0 ? proactiveMessages : undefined,
      cancelScheduleIds:
        cancelScheduleIds.length > 0 ? cancelScheduleIds : undefined,
    };
  }

  private normalizeSegments(input: unknown): StructuredResponseSegment[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const segments: StructuredResponseSegment[] = [];
    (input as unknown[]).forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return;
      }

      const sequenceRaw = (entry as { sequence?: unknown }).sequence ?? index + 1;
      const delayRaw = (entry as { delay_ms?: unknown }).delay_ms ?? 0;
      const contentRaw = (entry as { content?: unknown }).content;

      const sequence = Number(sequenceRaw);
      const delayMs = Number(delayRaw);
      const content =
        typeof contentRaw === "string" ? contentRaw.trim() : undefined;

      if (!Number.isFinite(sequence) || !content) {
        return;
      }

      segments.push({
        sequence: Math.max(1, Math.round(sequence)),
        delayMs:
          Number.isFinite(delayMs) && delayMs >= 0 ? Math.round(delayMs) : 0,
        content,
      });
    });

    segments.sort((a, b) => a.sequence - b.sequence);
    return segments;
  }

  private normalizeEmotionDelta(input: unknown): EmotionDeltaInstruction[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const instructions: EmotionDeltaInstruction[] = [];
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

      const numericDelta = Number(delta);
      if (!Number.isFinite(numericDelta)) {
        return;
      }

      const instruction: EmotionDeltaInstruction = {
        userId,
        metric: metric as EmotionMetric,
        delta: Math.round(numericDelta),
      };
      if (typeof reason === "string" && reason.trim().length > 0) {
        instruction.reason = reason.trim();
      }
      instructions.push(instruction);
    });

    return instructions;
  }

  private normalizeProactiveMessages(input: unknown): ProactiveMessageDraft[] {
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

  private normalizeCancelIds(input: unknown): string[] {
    if (!Array.isArray(input)) {
      return [];
    }
    return input
      .map((value) =>
        typeof value === "string" ? value.trim().toLowerCase() : null,
      )
      .filter((value): value is string => Boolean(value));
  }
}

// Export the singleton instance directly
const responderService = ResponderService.getInstance();
export default responderService;
export { ResponderService }; // Export the class type if needed elsewhere
