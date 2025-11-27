import configService from "@/config";
import contextManagerService from "@/context";
import { LLMRetryError } from "@/errors/LLMRetryError";
import agenticToolService from "@/llm/tools";
import loggerService from "@/logger";
import { PromptBuilder } from "@/prompt";
import {
  AppConfig,
  EmotionDeltaInstruction,
  EmotionMetric,
  EmotionSnapshot,
  ProactiveMessageSummary,
  ResponderResult,
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

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 8_000;
const MAX_DELAY_MS = 45_000;
const MAX_TOOL_ITERATIONS = 4;

class TopicStarterService {
  private static instance: TopicStarterService;
  private config: AppConfig | null = null;

  private constructor() {
    this.config = configService.getConfig();
    loggerService.logger.info("TopicStarterService initialized.");
  }

  public static getInstance(): TopicStarterService {
    if (!TopicStarterService.instance) {
      TopicStarterService.instance = new TopicStarterService();
    }
    return TopicStarterService.instance;
  }

  public async generateTopicStarter(
    channelId: string,
    systemPromptTemplate: string,
    personaDetails: string,
    botUserId: string,
    languageConfig?: { primary: string; fallback: string; autoDetect: boolean },
    emotionContext?: {
      snapshots?: EmotionSnapshot[];
      deltaCaps?: Partial<Record<EmotionMetric, number>>;
      pendingProactiveMessages?: ProactiveMessageSummary[];
    },
  ): Promise<ResponderResult | null> {
    const context = contextManagerService.getContext(channelId);
    const contextMessages = context?.messages || [];
    const serverId = context?.serverId;
    if (
      !this.config ||
      !this.config.primaryLlmApiKey ||
      !this.config.primaryLlmBaseUrl ||
      !this.config.primaryLlmModel
    ) {
      loggerService.logger.error(
        "TopicStarterService missing primary LLM configuration.",
      );
      return null;
    }

    if (contextMessages.length === 0) {
      return null;
    }

    const personaPrompts = configService.getPersonaPrompts();
    if (!personaPrompts) {
      return null;
    }

    const prompt = PromptBuilder.build({
      useCase: "topicStarter",
      systemPromptTemplate,
      personaDetails,
      personaPrompts,
      contextMessages,
      botUserId,
      languageConfig,
      emotionSnapshots: emotionContext?.snapshots,
      emotionDeltaCaps: emotionContext?.deltaCaps,
    });

    const availableTools = agenticToolService.getToolSpecs();
    return await this.callModelWithRetry(
      prompt,
      channelId,
      serverId,
      botUserId,
      availableTools,
    );
  }

  private async callModelWithRetry(
    prompt: {
      messages: ChatCompletionMessageParam[];
      temperature: number;
      maxTokens: number;
    },
    channelId: string,
    serverId: string | undefined,
    botUserId: string,
    tools: ChatCompletionTool[],
  ): Promise<ResponderResult | null> {
    try {
      return await retryWithExponentialBackoff(
        async () => {
          const result = await this.runConversation(
            prompt,
            channelId,
            serverId,
            botUserId,
            tools,
          );
          if (!result) {
            throw new Error("TopicStarter LLM returned null response.");
          }
          return result;
        },
        {
          maxAttempts: MAX_ATTEMPTS,
          baseDelayMs: BASE_DELAY_MS,
          maxDelayMs: MAX_DELAY_MS,
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
              "TopicStarter LLM call failed; retrying.",
            );
          },
        },
      );
    } catch (error) {
      loggerService.logger.error(
        { channelId, err: error },
        "TopicStarter retries exhausted.",
      );
      throw new LLMRetryError("topic-starter", MAX_ATTEMPTS, error);
    }
  }

  private async runConversation(
    prompt: {
      messages: ChatCompletionMessageParam[];
      temperature: number;
      maxTokens: number;
    },
    channelId: string,
    serverId: string | undefined,
    botUserId: string,
    tools: ChatCompletionTool[],
  ): Promise<ResponderResult | null> {
    const messageHistory: ChatCompletionMessageParam[] = [...prompt.messages];
    const client = getOpenAIClient("main");
    let toolIterations = 0;

    while (toolIterations < MAX_TOOL_ITERATIONS) {
      const allowTools =
        tools.length > 0 && toolIterations < MAX_TOOL_ITERATIONS;
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
        throw new Error("TopicStarter LLM returned no choices.");
      }

      const assistantMessage = choice.message;
      const toolCalls = assistantMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        const content = this.normalizeAssistantContent(
          assistantMessage.content,
        );
        if (!content.trim()) {
          throw new Error("TopicStarter LLM returned empty content.");
        }

        messageHistory.push({
          role: "assistant",
          content: assistantMessage.content ?? "",
        });

        const parsed = this.tryParse(content);
        if (parsed) {
          return parsed;
        }

        throw new Error("TopicStarter LLM returned unparseable content.");
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

        // Also log tool interactions into context for future awareness
        contextManagerService.updateContext(channelId, serverId ?? "DM", [
          {
            id: `${toolCall.id}-call`,
            channelId,
            guildId: serverId ?? "DM",
            authorId: botUserId,
            authorUsername: "llm-bot (tool)",
            content: `[tool_call] ${toolCall.function.name} args: ${toolCall.function.arguments}`,
            timestamp: Date.now(),
            mentionedUsers: [],
            mentionedRoles: [],
            mentionsEveryone: false,
            isBot: true,
            respondedTo: true,
            hasBeenRepliedTo: true,
          },
          {
            id: `${toolCall.id}-result`,
            channelId,
            guildId: serverId ?? "DM",
            authorId: botUserId,
            authorUsername: "llm-bot (tool)",
            content: `[tool_result] ${toolCall.function.name} result: ${serializedResult}`,
            timestamp: Date.now(),
            mentionedUsers: [],
            mentionedRoles: [],
            mentionsEveryone: false,
            isBot: true,
            respondedTo: true,
            hasBeenRepliedTo: true,
          },
        ]);
      }

      toolIterations += 1;
    }

    throw new Error(
      `TopicStarter LLM exceeded tool iteration limit (${MAX_TOOL_ITERATIONS}).`,
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
        "TopicStarter tool execution failed.",
      );
      throw error;
    }
  }

  private normalizeAssistantContent(
    content: ChatCompletionMessageParam["content"],
  ): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    return content
      .map((part: any) => ("text" in part && part.text ? part.text : ""))
      .join("\n")
      .trim();
  }

  private tryParse(raw: string): ResponderResult | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const jsonMatch = trimmed.match(/```json\s*([\s\S]+?)\s*```/i);
    const candidate = jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : trimmed;
    const parsed = parseStructuredJson(candidate, "responder");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const segments = this.normalizeSegments(
      (parsed as { messages?: unknown }).messages,
    );
    if (!segments.length) {
      return null;
    }

    const emotionDeltas = this.normalizeEmotionDelta(
      (parsed as { emotionDeltas?: unknown; emotion_delta?: unknown })
        .emotionDeltas ?? (parsed as any).emotion_delta,
    );

    return {
      messages: segments,
      emotionDeltas: emotionDeltas.length ? emotionDeltas : undefined,
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

      const content = this.sanitize(contentRawString);
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

  private sanitize(content: string): string {
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
}

const topicStarterService = TopicStarterService.getInstance();
export default topicStarterService;
export { TopicStarterService };
