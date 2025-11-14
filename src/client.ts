// src/client.ts
import bufferQueueService from "@/buffer";
import {
  GroupedHandlerKey,
  groupedHandlers,
  subcommandHandlers,
} from "@/commands/config/handlers";
import type { ConfigCommandContext } from "@/commands/config/types";
import configService from "@/config"; // Import class type
import contextManagerService from "@/context";
import type { ChannelProactiveMessageRow } from "@/db/schema";
import emotionService from "@/emotions";
import { LLMRetryError, LLMServiceName } from "@/errors/LLMRetryError";
import llmEvaluatorService from "@/llm/llm_evaluator";
import responderService from "@/llm/responder";
import loggerService from "@/logger";
import {
  cancelScheduledMessages,
  findProactiveMessage,
  getDueProactiveMessages,
  getPendingSummaries,
  markProactiveMessageStatus,
  rescheduleExistingProactiveMessage,
  scheduleProactiveMessage,
} from "@/proactive";
import {
  EmotionDeltaInstruction,
  EmotionDeltaSuggestion,
  PersonaDefinition,
  ProactiveMessageDraft,
  ServerConfig,
  SimpleMessage,
  StructuredResponseSegment,
} from "@/types";
import {
  CacheType, // Added
  ChannelType,
  Client,
  DMChannel,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  Partials,
  TextChannel,
} from "discord.js";

interface ConversationContext {
  channelId: string;
  messages: SimpleMessage[];
  serverConfig: ServerConfig | null;
  personaDefinition: PersonaDefinition;
  systemPromptTemplate: string;
  evaluationPromptTemplate: string;
  languageConfig?: { primary: string; fallback: string; autoDetect: boolean };
  channelContextMessages: SimpleMessage[];
  candidateUserIds: string[];
}

class BotClient {
  private static readonly PROACTIVE_DISPATCH_INTERVAL_MS = 60_000;
  private client: Client;
  private botId: string | null = null;
  private responseQueues: Map<string, Promise<void>> = new Map();
  private proactiveInterval: NodeJS.Timeout | null = null;
  private processingChannels: Set<string> = new Set();
  private deferredChannelBatches: Map<string, SimpleMessage[]> = new Map();

  constructor() {
    const config = configService.getConfig(); // Assuming config is loaded synchronously

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // Required to read message content
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message], // Required for DMs and uncached messages
    });

    this.registerEventHandlers();
    this.connectBufferToPipeline(); // Connect the buffer flush to the evaluation pipeline
    this.startProactiveDispatchLoop();
  }

  /**
   * @description Registers Discord event handlers.
   */
  private registerEventHandlers(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      this.botId = readyClient.user.id;
      loggerService.logger.info(
        `Logged in as ${readyClient.user.tag} (ID: ${this.botId})`,
      );
      // You might want to set the bot's status here
      readyClient.user.setActivity("Listening to chat...");
    });

    this.client.on(Events.MessageCreate, this.handleMessageCreate.bind(this));
    this.client.on(
      Events.InteractionCreate,
      this.handleInteractionCreate.bind(this),
    ); // Added

    this.client.on(Events.Error, (error) => {
      loggerService.logger.error({ err: error }, "Discord client error");
    });

    this.client.on(Events.Warn, (info) => {
      loggerService.logger.warn({ info }, "Discord client warning");
    });
  }

  /**
   * @description Connects the BufferQueueService flush mechanism to the evaluation/response pipeline.
   */
  private connectBufferToPipeline(): void {
    bufferQueueService.setFlushCallback(this.processMessageBatch.bind(this));
  }

  /**
   * @description Handles incoming messages from Discord.
   * @param message The discord.js Message object.
   */
  private async handleMessageCreate(message: Message): Promise<void> {
    // 1. Initial Filtering
    if (message.author.id === this.client.user?.id) return; // Ignore self
    loggerService.logger.info(
      `Received message from ${message.author.username} in channel ${message.channelId} in guild ${message.guildId}: ${message.content}`,
    );
    if (!message.content || message.content.trim().length === 0) {
      // Ignore empty messages or messages with only attachments
      loggerService.logger.info(
        `Ignoring empty message from ${message.author.username} in channel ${message.channelId} in guild ${message.guildId}`,
      );
      return;
    }
    if (message.content.startsWith("[!] Unable to contact")) return;
    // Ignore LLM failure notices

    if (!this.botId) {
      // Ensure botId is set (should be after ClientReady)
      loggerService.logger.warn("Bot ID not set yet, ignoring message.");
      return;
    }

    // --- Server-Specific Configuration Check ---
    if (message.guildId) {
      const serverConfig = configService.getServerConfig(message.guildId);
      loggerService.logger.debug(
        {
          guildId: message.guildId,
          channelId: message.channelId,
          allowedChannels: serverConfig.allowedChannels,
        },
        "Evaluating allowed channel configuration for incoming message.",
      );
      if (
        serverConfig.allowedChannels &&
        serverConfig.allowedChannels.length > 0 &&
        !serverConfig.allowedChannels.includes(message.channelId)
      ) {
        loggerService.logger.debug(
          `Ignoring message ${message.id} from channel ${message.channelId} in guild ${message.guildId} as it's not an allowed channel.`,
        );
        return; // Ignore message if channel is restricted
      }
    }
    // --- End Configuration Check ---

    // 2. Convert to SimpleMessage
    const simpleMessage: SimpleMessage = {
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      authorUsername: message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
      mentionedUsers: message.mentions.users.map((u) => u.id),
      mentionedRoles: message.mentions.roles.map((r) => r.id),
      mentionsEveryone: message.mentions.everyone,
      isBot: message.author.bot, // Redundant check, but good for the data structure
      reference: message.reference
        ? {
            messageId: message.reference.messageId ?? null,
            channelId: message.reference.channelId ?? null,
            guildId: message.reference.guildId ?? null,
          }
        : undefined,
      respondedTo: false, // Initialize as false (optional, default is undefined)
      hasBeenRepliedTo: false, // 新增：用于总结功能
    };

    emotionService.recordInteraction(
      simpleMessage.channelId,
      simpleMessage.authorId,
      simpleMessage.timestamp,
    );

    // 3. Update Context (do this regardless of buffering/evaluation pipeline)
    // Pass serverId (guildId) if available
    if (simpleMessage.guildId) {
      contextManagerService.updateContext(
        simpleMessage.channelId,
        simpleMessage.guildId,
        [simpleMessage],
      );
    } else {
      // Handle DM context update if needed, or log a warning if DMs aren't fully supported for context
      loggerService.logger.warn(
        `Attempted to update context for DM channel ${simpleMessage.channelId}. Server-specific features might be limited.`,
      );
      contextManagerService.updateContext(simpleMessage.channelId, "DM", [
        simpleMessage,
      ]); // Example if using a placeholder ID for DMs
    }

    // 4. Add to Buffer
    bufferQueueService.addMessage(simpleMessage);
  }

  /**
   * @description Processes a batch of messages flushed from the buffer using the updated batch logic.
   * @param channelId The ID of the channel.
   * @param messages The array of SimpleMessage objects flushed from the buffer.
   */
  private async processMessageBatch(
    channelId: string,
    messages: SimpleMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    if (this.processingChannels.has(channelId)) {
      const pending = this.deferredChannelBatches.get(channelId) ?? [];
      this.deferredChannelBatches.set(channelId, [...pending, ...messages]);
      loggerService.logger.debug(
        {
          channelId,
          pendingBatchSize: this.deferredChannelBatches.get(channelId)?.length,
        },
        "Channel pipeline busy; deferring message batch.",
      );
      return;
    }

    this.processingChannels.add(channelId);

    try {
      loggerService.logger.info(
        `Processing batch of ${messages.length} messages for channel ${channelId}`,
      );

      const context = this.prepareConversationContext(channelId, messages);
      if (!context) {
        loggerService.logger.warn(
          { channelId },
          "Conversation context could not be prepared. Skipping batch.",
        );
        return;
      }

      const isDirectMessage = !messages[0]?.guildId;
      let pendingProactiveSummaries = getPendingSummaries(channelId);
      let evaluationResult = null as Awaited<
        ReturnType<typeof llmEvaluatorService.evaluateMessages>
      >;

      if (!isDirectMessage) {
        const evaluationEmotionSnapshots = emotionService.getSnapshots(
          channelId,
          context.personaDefinition,
          context.candidateUserIds,
          5,
        );

        try {
          if (!this.botId) {
            loggerService.logger.error(
              { channelId },
              "Bot ID unavailable while running evaluator.",
            );
            return;
          }

          evaluationResult = await llmEvaluatorService.evaluateMessages(
            context.serverConfig?.responsiveness ?? 0.6,
            context.evaluationPromptTemplate,
            context.personaDefinition.details,
            this.botId,
            messages,
            context.channelContextMessages,
            evaluationEmotionSnapshots,
            pendingProactiveSummaries,
          );
        } catch (error) {
          if (error instanceof LLMRetryError) {
            loggerService.logger.error(
              { channelId, err: error },
              "Evaluator failed after retries.",
            );
            // do not notify evaluator failure msg
            // await this.notifyChannelOfLLMFailure(channelId, error.service);
          } else {
            loggerService.logger.error(
              { channelId, err: error },
              "Evaluator threw an error. Skipping batch.",
            );
          }
          return;
        }

        if (!evaluationResult) {
          loggerService.logger.error(
            { channelId },
            "Evaluator returned null result. Skipping batch.",
          );
          // ignore eval failure
          // return;
        }

        if (evaluationResult && evaluationResult.emotionDeltas?.length) {
          this.applyEmotionDeltas(
            channelId,
            context.personaDefinition,
            evaluationResult.emotionDeltas,
            "evaluator",
          );
        }

        if (
          evaluationResult &&
          (evaluationResult.proactiveMessages?.length ||
            evaluationResult.cancelScheduleIds?.length)
        ) {
          this.processProactiveDirectives(
            channelId,
            context.personaDefinition,
            evaluationResult.proactiveMessages,
            evaluationResult.cancelScheduleIds,
          );
          pendingProactiveSummaries = getPendingSummaries(channelId);
        }

        if (evaluationResult && !evaluationResult.should_respond) {
          loggerService.logger.info(
            { channelId, reason: evaluationResult.reason },
            "Evaluator advised not to respond to this batch.",
          );
          return;
        }
      } else {
        loggerService.logger.debug(
          { channelId },
          "Direct message batch detected; bypassing evaluator.",
        );
      }

      const finalTargetMessage =
        [...messages]
          .reverse()
          .find((msg) => !msg.isBot && msg.content.trim().length > 0) ??
        messages[messages.length - 1] ??
        null;

      await this.simulateTyping(
        channelId,
        context.serverConfig?.completionDelaySeconds,
      );

      const responseEmotionSnapshots = emotionService.getSnapshots(
        channelId,
        context.personaDefinition,
        Array.from(
          new Set(
            [
              ...context.candidateUserIds,
              finalTargetMessage?.authorId ?? "",
            ].filter((id) => id),
          ),
        ),
        5,
      );

      let responseResult;
      try {
        if (!this.botId) {
          loggerService.logger.error(
            { channelId },
            "Bot ID unavailable while generating response.",
          );
          return;
        }

        responseResult = await responderService.generateResponse(
          channelId,
          context.systemPromptTemplate,
          context.personaDefinition.details,
          this.botId,
          context.languageConfig,
          undefined, // disable forced target msg
          // finalTargetMessage ?? undefined,
          {
            targetUserId: finalTargetMessage?.authorId,
            snapshots: responseEmotionSnapshots,
            deltaCaps: context.personaDefinition.emotionDeltaCaps,
            pendingProactiveMessages: pendingProactiveSummaries,
          },
        );
      } catch (error) {
        if (error instanceof LLMRetryError) {
          loggerService.logger.error(
            { channelId, err: error },
            "Responder failed after retries.",
          );
          await this.notifyChannelOfLLMFailure(channelId, error.service);
        } else {
          loggerService.logger.error(
            { channelId, err: error },
            "Responder threw an error. Skipping batch.",
          );
        }
        return;
      }

      if (!responseResult) {
        loggerService.logger.warn(
          { channelId },
          "ResponderService returned null result. Skipping batch.",
        );
        return;
      }

      if (responseResult.emotionDeltas?.length) {
        this.applyEmotionDeltas(
          channelId,
          context.personaDefinition,
          responseResult.emotionDeltas,
          "responder",
        );
      }

      if (
        responseResult.proactiveMessages?.length ||
        responseResult.cancelScheduleIds?.length
      ) {
        this.processProactiveDirectives(
          channelId,
          context.personaDefinition,
          responseResult.proactiveMessages,
          responseResult.cancelScheduleIds,
        );
        pendingProactiveSummaries = getPendingSummaries(channelId);
      }

      if (!responseResult.segments.length) {
        loggerService.logger.warn(
          { channelId },
          "Responder returned empty segments. Nothing to send.",
        );
        return;
      }

      await this.enqueueResponseSegments(channelId, responseResult.segments);

      if (finalTargetMessage) {
        contextManagerService.markMessageAsResponded(
          channelId,
          finalTargetMessage.id,
        );
      }
    } finally {
      this.finalizeChannelProcessing(channelId);
    }
  }

  private finalizeChannelProcessing(channelId: string): void {
    this.processingChannels.delete(channelId);
    const deferred = this.deferredChannelBatches.get(channelId);
    if (!deferred || deferred.length === 0) {
      this.deferredChannelBatches.delete(channelId);
      return;
    }

    this.deferredChannelBatches.delete(channelId);
    setImmediate(() => {
      this.processMessageBatch(channelId, deferred).catch((error) => {
        loggerService.logger.error(
          { channelId, err: error },
          "Deferred batch processing failed.",
        );
      });
    });
  }

  private prepareConversationContext(
    channelId: string,
    messages: SimpleMessage[],
  ): ConversationContext | null {
    if (messages.length === 0) {
      return null;
    }

    const appConfig = configService.getConfig();
    const contextSnapshot = contextManagerService.getContext(channelId);
    const channelContextMessages = contextSnapshot?.messages ?? [];

    const primaryMessage = messages[0];
    const serverId = primaryMessage?.guildId ?? channelId;
    const isDirectMessage = !primaryMessage?.guildId;

    let serverConfig: ServerConfig | null = null;
    if (!isDirectMessage) {
      try {
        serverConfig = configService.getServerConfig(serverId);
      } catch (error) {
        loggerService.logger.error(
          { channelId, serverId, err: error },
          "Failed to load server configuration for conversation context.",
        );
      }
    } else {
      loggerService.logger.trace(
        { channelId },
        "Direct message context prepared without server configuration lookup.",
      );
    }

    const personaDefinition =
      (serverConfig
        ? configService.getPersonaDefinitionForContext(
            serverConfig.serverId,
            channelId,
          )
        : undefined) ?? configService.getPresetPersona("default");

    if (!personaDefinition) {
      loggerService.logger.error(
        { channelId },
        "Persona definition could not be resolved. Skipping batch.",
      );
      return null;
    }

    const personaPrompts = configService.getPersonaPrompts();
    if (!personaPrompts) {
      loggerService.logger.error(
        { channelId },
        "Persona prompt templates are not loaded. Skipping batch.",
      );
      return null;
    }

    const { systemPrompt, evaluationPrompt } = personaPrompts;
    if (!systemPrompt || !evaluationPrompt) {
      loggerService.logger.error(
        { channelId },
        "Persona prompt templates missing required fields. Skipping batch.",
      );
      return null;
    }

    const languageSource =
      serverConfig?.languageConfig ??
      (appConfig.language
        ? {
            primary: appConfig.language.defaultPrimary,
            fallback: appConfig.language.defaultFallback,
            autoDetect: appConfig.language.autoDetectEnabled,
          }
        : undefined);

    const languageConfig = languageSource
      ? {
          primary: languageSource.primary,
          fallback: languageSource.fallback,
          autoDetect: languageSource.autoDetect,
        }
      : undefined;

    const candidateUserIds = this.collectCandidateUserIds(
      channelContextMessages,
      messages,
    );

    return {
      channelId,
      messages,
      serverConfig,
      personaDefinition,
      systemPromptTemplate: systemPrompt,
      evaluationPromptTemplate: evaluationPrompt,
      languageConfig,
      channelContextMessages,
      candidateUserIds,
    };
  }

  private collectCandidateUserIds(
    contextMessages: SimpleMessage[],
    newMessages: SimpleMessage[],
  ): string[] {
    const ids = new Set<string>();
    const recentContext = contextMessages.slice(-20);
    const allMessages = [...recentContext, ...newMessages];

    for (const message of allMessages) {
      if (message.authorId && message.authorId !== this.botId) {
        ids.add(message.authorId);
      }
      if (Array.isArray(message.mentionedUsers)) {
        for (const mentioned of message.mentionedUsers) {
          if (mentioned && mentioned !== this.botId) {
            ids.add(mentioned);
          }
        }
      }
    }

    return Array.from(ids).slice(0, 25);
  }

  private async simulateTyping(
    channelId: string,
    delaySeconds?: number,
  ): Promise<void> {
    const totalDelayMs = Math.max(0, Math.round((delaySeconds ?? 0) * 1000));

    let sendableChannel: TextChannel | DMChannel | null = null;
    try {
      const fetchedChannel = await this.client.channels.fetch(channelId);
      if (!fetchedChannel) {
        loggerService.logger.debug(
          { channelId },
          "Failed to fetch channel for typing simulation.",
        );
        return;
      }

      if (fetchedChannel instanceof TextChannel) {
        sendableChannel = fetchedChannel;
      } else if (fetchedChannel instanceof DMChannel) {
        sendableChannel = fetchedChannel;
      }
    } catch (error) {
      loggerService.logger.debug(
        { channelId, err: error },
        "Error fetching channel for typing simulation.",
      );
      return;
    }

    if (!sendableChannel || typeof sendableChannel.sendTyping !== "function") {
      return;
    }

    const start = Date.now();
    const burstIntervalMs = 9000;

    while (true) {
      try {
        await sendableChannel.sendTyping().catch(() => {});
      } catch (error) {
        loggerService.logger.debug(
          { channelId, err: error },
          "Failed to send typing indicator.",
        );
        break;
      }

      if (totalDelayMs === 0) {
        break;
      }

      const elapsed = Date.now() - start;
      const remaining = totalDelayMs - elapsed;
      if (remaining <= 0) {
        break;
      }

      await this.delay(Math.min(burstIntervalMs, remaining));
    }
  }

  private applyEmotionDeltas(
    channelId: string,
    personaDefinition: PersonaDefinition | undefined,
    deltas: EmotionDeltaInstruction[] | undefined,
    source: string,
  ): void {
    if (!personaDefinition || !deltas || deltas.length === 0) {
      return;
    }

    const grouped = new Map<string, EmotionDeltaSuggestion[]>();
    deltas.forEach((delta) => {
      if (!delta || typeof delta.userId !== "string" || !delta.userId) {
        return;
      }
      if (!delta.metric) {
        return;
      }
      const numericDelta = Number(delta.delta);
      if (!Number.isFinite(numericDelta)) {
        return;
      }
      const existing = grouped.get(delta.userId) ?? [];
      existing.push({
        metric: delta.metric,
        delta: Math.round(numericDelta),
        reason: delta.reason,
      });
      grouped.set(delta.userId, existing);
    });

    const timestamp = Date.now();
    grouped.forEach((suggestions, userId) => {
      emotionService.applyModelSuggestions(channelId, userId, {
        suggestions,
        persona: personaDefinition,
        source,
        timestamp,
      });
      loggerService.logger.debug(
        { channelId, userId, source, suggestions },
        "Applied emotion delta suggestions.",
      );
    });
  }

  private processProactiveDirectives(
    channelId: string,
    personaDefinition: PersonaDefinition | undefined,
    drafts: ProactiveMessageDraft[] | undefined,
    cancelIds: string[] | undefined,
  ): void {
    if (cancelIds && cancelIds.length > 0) {
      cancelScheduledMessages(cancelIds.map((id) => id.toLowerCase()));
      loggerService.logger.info(
        { channelId, cancelIds },
        "Cancelled scheduled proactive messages as requested by LLM.",
      );
    }

    if (!drafts || drafts.length === 0) {
      return;
    }

    if (!personaDefinition) {
      loggerService.logger.warn(
        { channelId },
        "Cannot schedule proactive messages because persona definition is missing.",
      );
      return;
    }

    drafts.forEach((draft) => {
      const timestamp = this.parseScheduleTimestamp(draft.sendAt);
      if (timestamp === null) {
        loggerService.logger.warn(
          { channelId, value: draft.sendAt },
          "Ignoring proactive draft with invalid send_at value.",
        );
        return;
      }

      if (draft.id) {
        const existing = findProactiveMessage(draft.id);
        if (existing) {
          if (existing.channelId !== channelId) {
            loggerService.logger.warn(
              { channelId, id: draft.id, originalChannel: existing.channelId },
              "Cannot reschedule proactive message; channel mismatch.",
            );
            return;
          }
          if (existing.status !== "scheduled") {
            loggerService.logger.warn(
              { channelId, id: draft.id, status: existing.status },
              "Cannot reschedule proactive message that is not marked as scheduled.",
            );
            return;
          }

          try {
            rescheduleExistingProactiveMessage(
              draft.id,
              timestamp,
              draft.content,
              draft.reason ?? null,
            );
            loggerService.logger.info(
              { channelId, id: draft.id, sendAt: timestamp },
              "Rescheduled proactive message.",
            );
          } catch (error) {
            loggerService.logger.error(
              { channelId, id: draft.id, err: error },
              "Failed to reschedule proactive message.",
            );
          }
          return;
        }

        loggerService.logger.info(
          { channelId, id: draft.id },
          "Proactive message id not found; scheduling as a new entry.",
        );
      }

      try {
        scheduleProactiveMessage({
          channelId,
          personaId: personaDefinition.id,
          content: draft.content,
          scheduledAt: timestamp,
          reason: draft.reason,
        });
        loggerService.logger.info(
          { channelId, sendAt: timestamp },
          "Scheduled new proactive message.",
        );
      } catch (error) {
        loggerService.logger.error(
          { channelId, err: error },
          "Failed to schedule proactive message.",
        );
      }
    });
  }

  private parseScheduleTimestamp(value: string): number | null {
    if (!value) {
      return null;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  private startProactiveDispatchLoop(): void {
    if (this.proactiveInterval) {
      return;
    }
    this.proactiveInterval = setInterval(() => {
      this.dispatchDueProactiveMessages().catch((error) => {
        loggerService.logger.error(
          { err: error },
          "Error while dispatching proactive messages.",
        );
      });
    }, BotClient.PROACTIVE_DISPATCH_INTERVAL_MS);
  }

  private async dispatchDueProactiveMessages(): Promise<void> {
    const due = getDueProactiveMessages(Date.now());
    if (!due.length) {
      return;
    }

    for (const { record } of due) {
      try {
        await this.sendProactiveRecord(record);
        markProactiveMessageStatus(record.publicId, "sent");
      } catch (error) {
        loggerService.logger.error(
          { err: error, record },
          "Failed to send proactive message.",
        );
        markProactiveMessageStatus(record.publicId, "skipped");
      }
    }
  }

  private async sendProactiveRecord(
    record: ChannelProactiveMessageRow,
  ): Promise<void> {
    const trimmed = record.content.trim();
    if (!trimmed) {
      throw new Error("Proactive message content is empty");
    }

    const segments: StructuredResponseSegment[] = [
      {
        sequence: 1,
        delayMs: 0,
        content: trimmed,
      },
    ];

    await this.enqueueResponseSegments(record.channelId, segments);
  }

  private async notifyChannelOfLLMFailure(
    channelId: string,
    service: LLMServiceName,
  ): Promise<void> {
    const serviceLabel =
      service === "responder" ? "response generator" : "message evaluator";
    const segments: StructuredResponseSegment[] = [
      {
        sequence: 1,
        delayMs: 0,
        content: `[!] Unable to contact the ${serviceLabel} after repeated errors. Please try again latern.`,
      },
    ];

    try {
      await this.enqueueResponseSegments(channelId, segments);
    } catch (error) {
      loggerService.logger.error(
        { channelId, err: error },
        "Failed to notify channel about LLM failure.",
      );
    }
  }

  /**
   * @description Sends a response message to a specific Discord channel and adds it to context.
   * @param channelId The ID of the target channel.
   * @param content The text content of the response.
   */
  private async enqueueResponseSegments(
    channelId: string,
    segments: StructuredResponseSegment[],
  ): Promise<void> {
    const orderedSegments = [...segments].sort(
      (a, b) => a.sequence - b.sequence,
    );

    const previous = this.responseQueues.get(channelId) ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        loggerService.logger.error(
          `Previous response queue for channel ${channelId} failed:`,
          error,
        );
      })
      .then(() => this.processResponseSegments(channelId, orderedSegments));

    this.responseQueues.set(channelId, next);
    await next;
  }

  private async processResponseSegments(
    channelId: string,
    segments: StructuredResponseSegment[],
  ): Promise<void> {
    if (segments.length === 0) {
      return;
    }

    try {
      const fetchedChannel = await this.client.channels.fetch(channelId);
      if (!fetchedChannel) {
        loggerService.logger.error(
          `Unable to fetch channel ${channelId} when sending response segments.`,
        );
        return;
      }

      const sendableChannel =
        fetchedChannel instanceof TextChannel
          ? fetchedChannel
          : fetchedChannel instanceof DMChannel
            ? fetchedChannel
            : null;

      if (!sendableChannel) {
        loggerService.logger.error(
          `Channel ${channelId} is not a supported text channel type. Cannot send response segments.`,
        );
        return;
      }

      for (const segment of segments) {
        const delayMs = calculateDelayMs(segment); //override llm returned delayMs, it sucks
        try {
          if (typeof sendableChannel.sendTyping === "function") {
            await sendableChannel.sendTyping().catch(() => {});
          }
        } catch (typingError) {
          loggerService.logger.debug(
            `Failed to send typing indicator before segment in channel ${channelId}: ${typingError}`,
          );
        }

        if (delayMs > 0) {
          await this.delay(delayMs);
        }

        await this.sendSegmentMessage(
          sendableChannel,
          channelId,
          segment.content,
        );
      }
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to process response segments",
      );
    }
  }

  private async sendSegmentMessage(
    channel: TextChannel | DMChannel,
    channelId: string,
    content: string,
  ): Promise<void> {
    try {
      const sentMessage = await channel.send(content);
      loggerService.logger.info(
        `Sent response to channel ${channelId}: "${content}" (ID: ${sentMessage.id})`,
      );
      this.addBotMessageToContext(channelId, sentMessage, content);
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to send response segment",
      );
    }
  }

  private addBotMessageToContext(
    channelId: string,
    sentMessage: Message,
    content: string,
  ): void {
    if (!this.botId || !this.client.user) {
      return;
    }

    const botSimpleMessage: SimpleMessage = {
      id: sentMessage.id,
      channelId,
      guildId: sentMessage.guildId ?? null,
      authorId: this.botId,
      authorUsername: this.client.user.username,
      content,
      timestamp: sentMessage.createdTimestamp,
      mentionedUsers: [],
      mentionedRoles: [],
      mentionsEveryone: false,
      isBot: true,
      respondedTo: true,
      hasBeenRepliedTo: false,
    };

    const serverId = botSimpleMessage.guildId ?? "DM";
    contextManagerService.updateContext(channelId, serverId, [
      botSimpleMessage,
    ]);
    loggerService.logger.debug(
      `Added own response (ID: ${sentMessage.id}) to context for channel ${channelId}`,
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @description Starts the Discord bot client.
   */
  public async start(): Promise<void> {
    try {
      const config = configService.getConfig();
      if (!config.discordToken) {
        loggerService.logger.error(
          "CRITICAL: Discord Bot Token not found in configuration.",
        );
        process.exit(1);
      }
      loggerService.logger.info(
        `Logging in to Discord...`, // Removed token from log
      );
      await this.client.login(config.discordToken);
    } catch (error) {
      loggerService.logger.error(`Failed to login to Discord: ${error}`);
      process.exit(1);
    }
  }

  /**
   * @description Stops the Discord bot client gracefully.
   */
  public async stop(): Promise<void> {
    loggerService.logger.info("Shutting down bot client...");
    if (this.proactiveInterval) {
      clearInterval(this.proactiveInterval);
      this.proactiveInterval = null;
    }
    // Flush any remaining messages in buffers
    await bufferQueueService.flushAll();
    // Flush context to disk
    await contextManagerService.flushAllContextsToDisk();
    // Destroy the client
    this.client.destroy();
    loggerService.logger.info("Bot client shut down.");
  }

  /**
   * @description Handles incoming interactions (slash commands, context menus, select menus, modals).
   * @param interaction The interaction object.
   */
  private async handleInteractionCreate(
    interaction: Interaction<CacheType>,
  ): Promise<void> {
    // 处理消息上下文菜单命令
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === "📊 Summarize Messages") {
        const { messageSummaryCommand } = await import(
          "./commands/context/summarize.js"
        );
        await messageSummaryCommand.execute(interaction);
      }
      return;
    }

    // 处理总结功能相关的选择菜单交互
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("summary_")) {
        const { handleSummaryConfigSelect } = await import(
          "./commands/context/summarize.js"
        );
        await handleSummaryConfigSelect(interaction);
      }
      return;
    }

    // 处理总结功能相关的Modal提交
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("summary_custom_count_")) {
        const { handleCustomCountModal } = await import(
          "./commands/context/summarize.js"
        );
        await handleCustomCountModal(interaction);
      }
      return;
    }

    // 处理总结功能相关的按钮交互
    if (interaction.isButton()) {
      if (
        interaction.customId.startsWith("summary_confirm_") ||
        interaction.customId.startsWith("summary_cancel_")
      ) {
        const { handleSummaryButtonClick } = await import(
          "./commands/context/summarize.js"
        );
        await handleSummaryButtonClick(interaction);
        return;
      }
    }

    // 只处理斜杠命令
    if (!interaction.isChatInputCommand()) return;
    // TODO: Uncomment this when want to disable config commands in DMs
    // if (!interaction.inGuild()) {
    //   await interaction.reply({
    //     content: "Configuration commands can only be used in a server.",
    //     ephemeral: true,
    //   });
    //   return;
    // }

    const { commandName, guildId, channel, channelId } = interaction;
    const options = interaction.options;
    const isDm = channel?.type === ChannelType.DM;

    if (commandName === "config") {
      // Ensure the user has admin permissions (double check, although command definition should handle it)
      // Disable admin check for now
      // if (!interaction.memberPermissions?.has("Administrator") && !isDm) {
      //   await interaction.reply({
      //     content: "You need administrator permissions to use this command.",
      //     ephemeral: true,
      //   });
      //   return;
      // }

      let subcommandGroup: string | null = null;
      try {
        subcommandGroup = options.getSubcommandGroup(false);
      } catch {
        subcommandGroup = null;
      }

      const subcommand = options.getSubcommand(true);
      const commandDescriptor = subcommandGroup
        ? `${subcommandGroup} ${subcommand}`
        : subcommand;
      loggerService.logger.info(
        `Received config command '${commandDescriptor}' from user ${interaction.user.tag} in guild ${guildId}`,
      );

      try {
        // Defer reply for potentially long operations
        if (isDm) {
          await interaction.deferReply();
        } else {
          await interaction.deferReply({ ephemeral: true });
        }

        const serverConfig = configService.getServerConfig(
          guildId ?? channelId, // DMs don't have a guildId, so use the channelId
        ); // Get current or default config

        const handlerContext: ConfigCommandContext = {
          interaction,
          options,
          serverConfig,
          isDm,
          guildId,
          channelId,
          subcommand,
          subcommandGroup,
          commandDescriptor,
        };

        if (subcommandGroup) {
          if (
            Object.prototype.hasOwnProperty.call(
              groupedHandlers,
              subcommandGroup,
            )
          ) {
            const handler =
              groupedHandlers[subcommandGroup as GroupedHandlerKey];
            await handler(handlerContext);
          } else {
            await interaction.editReply("Unknown configuration command.");
          }
        } else {
          const handler = subcommandHandlers[subcommand];
          if (handler) {
            await handler(handlerContext);
          } else {
            await interaction.editReply("Unknown configuration command.");
          }
        }
      } catch (error: any) {
        const errorPayload =
          error instanceof Error
            ? {
                err: {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                },
              }
            : { err: error };

        loggerService.logger.error(
          errorPayload,
          `Error handling '/config ${commandDescriptor}' interaction.`,
        );
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(
            "An error occurred while processing the command.",
          );
        } else {
          await interaction.reply(
            isDm
              ? { content: "An error occurred while processing the command." }
              : {
                  content: "An error occurred while processing the command.",
                  ephemeral: true,
                },
          );
        }
      }
    }

    // Handle other commands if added later
  }
}

// helper functions below

/**
 * @description Calculates the delay time by the content length, in simulation of human typing.
 * @param seg single structured response segment.
 * @returns
 */
function calculateDelayMs(seg: StructuredResponseSegment): number {
  const MS_PER_CHAR = 170; // 平均每字符170ms (~6 chars/s)
  const MIN_DELAY = 900; // 最小 0.9s
  const MAX_DELAY = 6500; // 最大 6.5s
  const text = seg.content || "";

  const len = text.length;
  let delay = len * MS_PER_CHAR;

  // pause on the first segment: 0.6s ~ 1.5s
  delay += 600 + Math.random() * 900;

  // add pause on punctuation
  if (/[.?!]$/.test(text)) delay += 250 + Math.random() * 200;
  if (/[,;:]$/.test(text)) delay += 120 + Math.random() * 100;

  // add some jitter
  delay *= 0.9 + Math.random() * 0.3;

  // limit the range
  const calculeted = Math.floor(
    Math.min(MAX_DELAY, Math.max(MIN_DELAY, delay)),
  );
  return Math.max(calculeted, seg.delayMs);
}
export default BotClient;
