// src/llm/responder.ts
import configService from "@/config";
import contextManagerService from "@/context";
import loggerService from "@/logger";
import { AppConfig, SimpleMessage, StructuredResponseSegment } from "@/types";
import { callChatCompletionApi } from "./openai_client";
import { jsonrepair } from "jsonrepair";
import { PromptBuilder } from "@/prompt";
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
    systemPromptTemplate: string, // Added
    personaDetails: string, // Added
    languageConfig?: { primary: string; fallback: string; autoDetect: boolean }, // Added
    targetMessage?: SimpleMessage,
  ): Promise<StructuredResponseSegment[] | null> {
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

      const structured = this.parseStructuredResponse(cleanedText);
      if (!structured) {
        loggerService.logger.warn(
          "Failed to parse structured response from LLM. Falling back to single message.",
        );
        return [
          {
            sequence: 1,
            delayMs: 0,
            content: cleanedText,
          },
        ];
      }

      return structured;
    } catch (error) {
      loggerService.logger.error({ err: error }, "Error generating response");
      return null;
    }
  }

  private parseStructuredResponse(
    raw: string,
  ): StructuredResponseSegment[] | null {
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

    const segmentsSource = Array.isArray(parsed)
      ? parsed
      : (parsed as { messages?: unknown }).messages;

    if (!Array.isArray(segmentsSource)) {
      loggerService.logger.warn(
        "Structured response JSON did not contain an array of messages.",
      );
      return null;
    }

    const segments: StructuredResponseSegment[] = segmentsSource
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const sequenceRaw =
          (entry as { sequence?: unknown }).sequence ?? index + 1;
        const delayRaw = (entry as { delay_ms?: unknown }).delay_ms ?? 0;
        const contentRaw = (entry as { content?: unknown }).content;

        const sequence = Number(sequenceRaw);
        const delayMs = Number(delayRaw);
        const content =
          typeof contentRaw === "string" ? contentRaw.trim() : undefined;

        if (!Number.isFinite(sequence) || !content) {
          return null;
        }

        return {
          sequence: Math.max(1, Math.round(sequence)),
          delayMs:
            Number.isFinite(delayMs) && delayMs >= 0 ? Math.round(delayMs) : 0,
          content,
        } satisfies StructuredResponseSegment;
      })
      .filter(
        (segment): segment is StructuredResponseSegment => segment !== null,
      );

    if (segments.length === 0) {
      return null;
    }

    segments.sort((a, b) => a.sequence - b.sequence);
    return segments;
  }
}

// Export the singleton instance directly
const responderService = ResponderService.getInstance();
export default responderService;
export { ResponderService }; // Export the class type if needed elsewhere
