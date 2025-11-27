// src/llm/responder.ts
import configService from "@/config";
import contextManagerService from "@/context";
import { LLMRetryError } from "@/errors/LLMRetryError";
import agenticToolService from "@/llm/tools";
import loggerService from "@/logger";
import type { BuiltPrompt } from "@/prompt";
import { PromptBuilder } from "@/prompt";
import {
  AppConfig,
  EmotionDeltaInstruction,
  EmotionMetric,
  EmotionSnapshot,
  ProactiveMessageDraft,
  ProactiveMessageSummary,
  ResponderResult,
  SimpleMessage,
  StructuredResponseSegment,
} from "@/types";
import { retryWithExponentialBackoff } from "@/utils/retry";
import {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { getOpenAIClient } from "./openai_client";
import { parseStructuredJson } from "./structuredJson";

const SUPPORTED_EMOTION_METRICS: EmotionMetric[] = [
  "affinity",
  "annoyance",
  "trust",
  "curiosity",
];

const RESPONDER_MAX_ATTEMPTS = 5;
const RESPONDER_BASE_DELAY_MS = 10_000;
const RESPONDER_MAX_DELAY_MS = 60_000;
const RESPONDER_MAX_TOOL_ITERATIONS = 5;
const RESPONDER_MAX_SCHEMA_REPAIRS = 2;

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
    botUserId: string,
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
        botUserId,
        languageConfig,
        targetMessage,
        targetUserId: emotionContext?.targetUserId,
        emotionSnapshots: emotionContext?.snapshots,
        emotionDeltaCaps: emotionContext?.deltaCaps,
        pendingProactiveMessages: emotionContext?.pendingProactiveMessages,
      });

      const availableTools = agenticToolService.getToolSpecs();
      const result = await this.callResponderModelWithRetry(
        prompt,
        channelId,
        availableTools,
      );
      return result;
    } catch (error) {
      if (error instanceof LLMRetryError) {
        throw error;
      }
      loggerService.logger.error({ err: error }, "Error generating response");
      return null;
    }
  }

  private async callResponderModelWithRetry(
    prompt: BuiltPrompt,
    channelId: string,
    tools: ChatCompletionTool[],
  ): Promise<ResponderResult | null> {
    try {
      return await retryWithExponentialBackoff(
        async () => {
          const result = await this.runResponderConversation(prompt, tools);
          if (!result) {
            throw new Error("Responder LLM returned null response.");
          }
          return result;
        },
        {
          maxAttempts: RESPONDER_MAX_ATTEMPTS,
          baseDelayMs: RESPONDER_BASE_DELAY_MS,
          maxDelayMs: RESPONDER_MAX_DELAY_MS,
          onRetry: (attempt, error, delayMs) => {
            loggerService.logger.warn(
              {
                channelId,
                attempt,
                delayMs,
                err:
                  error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : "unknown",
              },
              "Responder LLM call failed; retrying with backoff.",
            );
          },
        },
      );
    } catch (error) {
      loggerService.logger.error(
        { channelId, err: error },
        "Responder LLM retries exhausted.",
      );
      throw new LLMRetryError("responder", RESPONDER_MAX_ATTEMPTS, error);
    }
  }

  private async runResponderConversation(
    prompt: BuiltPrompt,
    tools: ChatCompletionTool[],
  ): Promise<ResponderResult | null> {
    const messageHistory: ChatCompletionMessageParam[] = [...prompt.messages];
    const client = getOpenAIClient("main");
    let attempts = 0;
    let toolIterations = 0;
    let schemaRepairs = 0;

    while (
      attempts <
      RESPONDER_MAX_TOOL_ITERATIONS + RESPONDER_MAX_SCHEMA_REPAIRS
    ) {
      attempts += 1;
      const allowTools =
        tools.length > 0 && toolIterations < RESPONDER_MAX_TOOL_ITERATIONS;
      const completion = await client.chat.completions.create({
        model: this.config!.primaryLlmModel,
        messages: messageHistory,
        reasoning_effort: "medium",
        temperature: prompt.temperature,
        max_tokens: prompt.maxTokens,
        tool_choice: allowTools ? "auto" : "none",
        tools: allowTools ? tools : undefined,
      });

      const choice = completion.choices[0];
      if (!choice) {
        throw new Error("Responder LLM returned no choices.");
      }

      const assistantMessage = choice.message;
      const toolCalls = assistantMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        const content = this.normalizeAssistantContent(
          assistantMessage.content,
        );
        if (!content.trim()) {
          throw new Error("Responder LLM returned empty assistant content.");
        }

        messageHistory.push({
          role: "assistant",
          content: assistantMessage.content ?? "",
        });

        const { result, error } = this.tryParseResponderContent(content);
        if (result) {
          return result;
        }

        schemaRepairs += 1;
        if (schemaRepairs > RESPONDER_MAX_SCHEMA_REPAIRS) {
          throw new Error(
            "Responder LLM returned unparseable content after schema repairs.",
          );
        }

        messageHistory.push({
          role: "user",
          content: [
            "Your last response was invalid.",
            error ? `Issue: ${error}.` : null,
            "If you intended to call a tool, emit a proper tool call now (do not place tool instructions in message content).",
            "If you intended to finish, re-emit a single response as a JSON code block using the exact given shape",
          ]
            .filter(Boolean)
            .join(" "),
        });

        continue;
      }

      messageHistory.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const toolResult = await this.executeToolCall(toolCall);
        const serializedResult =
          typeof toolResult === "string"
            ? toolResult
            : JSON.stringify(toolResult);

        messageHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: serializedResult,
        });
      }

      toolIterations += 1;
      continue;
    }

    throw new Error(
      `Responder LLM failed to produce valid output within tool (${RESPONDER_MAX_TOOL_ITERATIONS}) and schema repair (${RESPONDER_MAX_SCHEMA_REPAIRS}) limits.`,
    );
  }

  private async executeToolCall(
    toolCall: ChatCompletionMessageToolCall,
  ): Promise<unknown> {
    try {
      return await agenticToolService.executeToolCall(
        toolCall.function.name,
        toolCall.function.arguments,
      );
    } catch (error) {
      loggerService.logger.error(
        {
          toolName: toolCall.function.name,
          err: error,
        },
        "Agentic tool execution failed.",
      );
      throw error;
    }
  }

  private normalizeAssistantContent(
    content: ChatCompletionMessageParam["content"],
  ): string {
    if (!content) {
      return "";
    }

    if (typeof content === "string") {
      return content;
    }

    return content
      .map((part: any) => ("text" in part && part.text ? part.text : ""))
      .join("\n")
      .trim();
  }

  private tryParseResponderContent(content: string): {
    result: ResponderResult | null;
    error?: string;
  } {
    const trimmed = content.trim();
    if (!trimmed) {
      return { result: null, error: "Empty assistant content." };
    }
    if (trimmed.toLowerCase().includes("as an ai language model")) {
      return { result: null, error: "Contained AI boilerplate disclaimer." };
    }

    const jsonMatch = trimmed.match(/```json\s*([\s\S]+?)\s*```/i);
    const candidate = jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : trimmed;

    try {
      const parsed = this.parseResponderOutput(candidate);
      if (!parsed) {
        return { result: null, error: "Parsed JSON contained no messages." };
      }
      return { result: parsed };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown responder parse error";
      loggerService.logger.warn(
        { err: message },
        "Responder content failed schema parse.",
      );
      return { result: null, error: message };
    }
  }

  private parseResponderOutput(raw: string): ResponderResult | null {
    if (!raw) {
      throw new Error("Empty responder LLM response.");
    }

    const parsed = parseStructuredJson(raw, "responder");
    if (!parsed) {
      throw new Error("Failed to parse responder LLM response as JSON.");
    }
    if (!this.isParsedJsonExpectedShape(parsed)) {
      throw new Error("Unexpected responder LLM response shape");
    }

    let segmentsSource: unknown;
    let deltaSource: unknown;
    let proactiveSource: unknown;
    let cancelSource: unknown;

    segmentsSource = parsed.messages;
    deltaSource = parsed.emotionDeltas;
    proactiveSource = parsed.proactiveMessages;
    cancelSource = parsed.cancelScheduleIds;

    const segments = this.normalizeSegments(segmentsSource);
    if (!segments.length) {
      return null;
    }

    const emotionDeltas = this.normalizeEmotionDelta(deltaSource);
    const proactiveMessages = this.normalizeProactiveMessages(proactiveSource);
    const cancelScheduleIds = this.normalizeCancelIds(cancelSource);

    return {
      messages: segments,
      emotionDeltas: emotionDeltas.length > 0 ? emotionDeltas : undefined,
      proactiveMessages:
        proactiveMessages.length > 0 ? proactiveMessages : undefined,
      cancelScheduleIds:
        cancelScheduleIds.length > 0 ? cancelScheduleIds : undefined,
    };
  }

  private isParsedJsonExpectedShape(input: unknown): input is ResponderResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return false;
    }

    return "messages" in input;
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

      const sequenceRaw =
        (entry as { sequence?: unknown }).sequence ?? index + 1;
      const delayRaw = (entry as { delay_ms?: unknown }).delay_ms ?? 0;
      const contentRaw = (entry as { content?: unknown }).content;

      const sequence = Number(sequenceRaw);
      const delayMs = Number(delayRaw);
      const contentRawString =
        typeof contentRaw === "string" ? contentRaw.trim() : undefined;
      if (!Number.isFinite(sequence) || !contentRawString) {
        return;
      }

      const content = this.sanitizeDiscordContent(contentRawString);

      if (!content.length) {
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

  private sanitizeDiscordContent(content: string): string {
    return content
      .replace(/\\(<[@#!&])/g, "$1")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[\u200b\u200c\u200d\uFEFF]/g, "")
      .replace(/(?<!<)@(\d{15,25})\b/g, "<@$1>");
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
