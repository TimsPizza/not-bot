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
import llmEvaluatorService from "@/llm/llm_evaluator";
import responderService from "@/llm/responder";
import loggerService from "@/logger";
import scorerService from "@/scorer"; // Ensure this uses getDecisionForBatch
import {
  PersonaDefinition,
  ScoreDecision,
  SimpleMessage,
  StructuredResponseSegment,
  ServerConfig,
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

class BotClient {
  private client: Client;
  private botId: string | null = null;
  private responseQueues: Map<string, Promise<void>> = new Map();

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
    this.connectBufferToScorer(); // Connect the buffer flush to the scoring logic
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
   * @description Connects the BufferQueueService flush mechanism to the scoring pipeline.
   */
  private connectBufferToScorer(): void {
    bufferQueueService.setFlushCallback(this.processMessageBatch.bind(this));
  }

  /**
   * @description Handles incoming messages from Discord.
   * @param message The discord.js Message object.
   */
  private async handleMessageCreate(message: Message): Promise<void> {
    // 1. Initial Filtering
    if (message.author.bot) return; // Ignore bots (including self)
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
    if (!this.botId) {
      // Ensure botId is set (should be after ClientReady)
      loggerService.logger.warn("Bot ID not set yet, ignoring message.");
      return;
    }

    // --- Server-Specific Configuration Check ---
    if (message.guildId) {
      const serverConfig = configService.getServerConfig(message.guildId);
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

    // 3. Update Context (do this regardless of buffering/scoring)
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
    loggerService.logger.info(
      `Processing batch of ${messages.length} messages for channel ${channelId}`,
    );

    let activeServerConfig: ServerConfig | null = null;

    // 1. Score Messages Individually
    // Note: scorerService.scoreMessages might internally use context now if needed by rules
    const scoringResults = scorerService.scoreMessages(channelId, messages);

    // 2. Get Overall Decision for the Batch using the updated scorer method
    // Note: getDecisionForBatch currently does NOT use context based on user feedback
    const batchDecision = scorerService.getDecisionForBatch(scoringResults);

    // 3. Handle Batch Decision
    let shouldRespond = false;
    let finalTargetMessage: SimpleMessage | null = null; // Message to target, if any
    // personaDefinition will be loaded later if needed
    // const firstMessage = messages[0]; // Define later when known to be safe

    switch (batchDecision) {
      case ScoreDecision.Respond:
        loggerService.logger.info(
          `Batch for channel ${channelId} scored high. Proceeding to generate response.`,
        );
        shouldRespond = true;
        // For direct response based on batch score, we don't have a specific target message from scoring alone.
        // The responder will use the general context.
        // Find the highest scoring message in the batch to potentially mark as responded to later
        let highestScore = -Infinity;
        let highestScoringMsgId: string | null = null;
        scoringResults.forEach((r) => {
          if (r.score > highestScore) {
            highestScore = r.score;
            highestScoringMsgId = r.messageId;
          }
        });
        finalTargetMessage =
          messages.find((msg) => msg.id === highestScoringMsgId) || null;
        if (finalTargetMessage) {
          loggerService.logger.debug(
            `Highest scoring message in batch (ID: ${finalTargetMessage.id}) identified for potential marking.`,
          );
        }
        break;

      case ScoreDecision.Evaluate:
        loggerService.logger.info(
          `Batch for channel ${channelId} scored in evaluation range. Evaluating with LLM using context.`,
        );
        // --- Get channel context ---
        const context = contextManagerService.getContext(channelId);
        const channelContextMessages = context?.messages || [];
        loggerService.logger.debug(
          `Retrieved ${channelContextMessages.length} context messages for evaluation.`,
        );
        // -------------------------

        // --- Get server responsiveness ---
        let responsiveness = 0.6; // Default if not in a guild
        const firstMessage = messages[0]; // Get first message to find guildId
        if (firstMessage?.guildId || firstMessage?.channelId) {
          const serverConfig = configService.getServerConfig(
            firstMessage.guildId ?? firstMessage.channelId, // DMs don't have a guildId, so use the channelId
          );
          activeServerConfig = serverConfig;
          responsiveness = serverConfig.responsiveness;
        } else {
          loggerService.logger.warn(
            `Could not determine guildId from message batch in channel ${channelId}. Using default responsiveness.`,
          );
        }
        // --------------------------------

        // --- Get Persona and Prompt Template ---
        let evaluation_personaDefinition: PersonaDefinition | undefined; // Use temporary name for this scope
        let evaluationPromptTemplate: string | undefined;
        const evaluation_firstMessage = messages[0]; // Safe to access here if messages is not empty

        if (
          evaluation_firstMessage?.guildId ||
          evaluation_firstMessage?.channelId
        ) {
          evaluation_personaDefinition =
            configService.getPersonaDefinitionForContext(
              evaluation_firstMessage.guildId ??
                evaluation_firstMessage.channelId, // DMs don't have a guildId, so use the channelId
              channelId,
            );
          const basePrompts = configService.getPersonaPrompts();
          evaluationPromptTemplate = basePrompts?.evaluationPrompt;
        }

        if (!evaluation_personaDefinition || !evaluationPromptTemplate) {
          loggerService.logger.error(
            `Could not load persona definition or evaluation prompt template for ${evaluation_firstMessage?.guildId}/${channelId}. Cannot evaluate.`,
          );
          shouldRespond = false; // Cannot evaluate, so don't respond
          break; // Exit the switch case for Evaluate
        }
        // -----------------------------------

        // Pass responsiveness, prompt template, persona details, batch, and context to the evaluator
        // Note: Pass the details loaded specifically for evaluation
        const evaluationResult = await llmEvaluatorService.evaluateMessages(
          responsiveness,
          evaluationPromptTemplate,
          evaluation_personaDefinition.details,
          messages,
          channelContextMessages,
        );

        if (evaluationResult?.should_respond) {
          shouldRespond = true;
          // Check if the LLM specified a target message
          if (evaluationResult.target_message_id) {
            // Find the target message within the current batch
            finalTargetMessage =
              messages.find(
                (msg) => msg.id === evaluationResult.target_message_id,
              ) || null;
            if (finalTargetMessage) {
              loggerService.logger.info(
                `LLM Evaluator recommended responding specifically to message ${finalTargetMessage.id}. Reason: ${evaluationResult.reason}`,
              );
            } else {
              // LLM specified a target, but it wasn't found in the current batch (edge case)
              loggerService.logger.warn(
                `LLM Evaluator recommended responding to ${evaluationResult.target_message_id}, but message not found in current batch. Responding generally.`,
              );
              finalTargetMessage = null; // Respond generally
            }
          } else {
            // LLM decided to respond, but didn't pick a specific message - respond generally
            loggerService.logger.info(
              `LLM Evaluator recommended responding to the batch generally. Reason: ${evaluationResult.reason}`,
            );
            finalTargetMessage = null;
          }
        } else if (evaluationResult) {
          loggerService.logger.info(
            `LLM Evaluator decided not to respond to the batch. Reason: ${evaluationResult.reason}`,
          );
          shouldRespond = false;
        } else {
          loggerService.logger.error(
            `LLM Evaluator failed to return a result for channel ${channelId}. Responding for testing purpose.`,
          );
          // Choose to respond for now - this will be tested and adjusted later
          shouldRespond = true;
        }
        break;

      case ScoreDecision.Discard:
        loggerService.logger.info(
          `Batch for channel ${channelId} scored low or was invalid. Discarding.`,
        );
        shouldRespond = false;
        break;
    }

    // 4. Generate and Send Response (if shouldRespond is true)
    if (shouldRespond) {
      // --- Get Persona, Prompt Template and Language Config for Responder ---
      let systemPromptTemplate: string | undefined;
      let personaDefinition: PersonaDefinition | undefined;
      let personaDetails: string | undefined;
      let languageConfig:
        | { primary: string; fallback: string; autoDetect: boolean }
        | undefined;
      const firstMessage = messages.length > 0 ? messages[0] : null; // Safely get first message

      if (firstMessage?.guildId || firstMessage?.channelId) {
        const serverId = firstMessage.guildId ?? firstMessage.channelId; // DMs don't have a guildId, so use the channelId

        // Get persona information
        personaDefinition = configService.getPersonaDefinitionForContext(
          serverId,
          channelId,
        );
        const basePrompts = configService.getPersonaPrompts(); // Load base prompt templates
        systemPromptTemplate = basePrompts?.systemPrompt;
        personaDetails = personaDefinition?.details; // Get details from the resolved persona

        // Get language configuration
        activeServerConfig = configService.getServerConfig(serverId);
        if (activeServerConfig.languageConfig) {
          languageConfig = activeServerConfig.languageConfig;
        } else {
          // Use default from global config
          const globalConfig = configService.getConfig();
          if (globalConfig.language) {
            languageConfig = {
              primary: globalConfig.language.defaultPrimary,
              fallback: globalConfig.language.defaultFallback,
              autoDetect: globalConfig.language.autoDetectEnabled,
            };
          }
        }
      } else {
        loggerService.logger.warn(
          `Cannot determine guildId for response generation in channel ${channelId}. Cannot apply persona.`,
        );
        // Prevent response if we can't determine the server context
        shouldRespond = false;
      }

      // Validate that we have everything needed to generate a response
      if (!personaDefinition || !systemPromptTemplate || !personaDetails) {
        loggerService.logger.error(
          `Could not load necessary persona/prompt info for ${firstMessage?.guildId}/${channelId}. Cannot generate response.`,
        );
        shouldRespond = false; // Cannot respond without full info
      }
      // ----------------------------------------------------

      // Proceed only if we still should respond after loading persona info
      if (shouldRespond && systemPromptTemplate && personaDetails) {
        // Double-check shouldRespond status
        if (finalTargetMessage) {
          loggerService.logger.debug(
            `Generating response targeting message ${finalTargetMessage.id}...`,
          );
        } else {
          loggerService.logger.debug(
            `Generating general response for channel ${channelId} based on the latest context...`,
          );
        }

        // Simulate typing before calling the potentially long-running LLM
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (channel instanceof TextChannel) {
            await channel.sendTyping();
          }
        } catch (typingError) {
          loggerService.logger.warn(
            `Failed to send typing indicator to channel ${channelId}: ${typingError}`,
          );
        }

        const configuredDelaySeconds =
          activeServerConfig?.completionDelaySeconds ?? 3;
        const completionDelaySeconds = Math.max(3, configuredDelaySeconds);
        if (completionDelaySeconds > 0) {
          await this.delay(completionDelaySeconds * 1000);
          // Refresh typing indicator so the user sees continued activity.
          try {
            const channel = await this.client.channels.fetch(channelId);
            if (channel instanceof TextChannel) {
              await channel.sendTyping();
            }
          } catch (typingError) {
            loggerService.logger.warn(
              `Failed to refresh typing indicator after delay in channel ${channelId}: ${typingError}`,
            );
          }
        }

        // Pass the specific target message, template, details, and language config to the responder
        const responseSegments = await responderService.generateResponse(
          channelId,
          systemPromptTemplate, // Already checked for existence
          personaDetails, // Already checked for existence
          languageConfig, // Language configuration
          finalTargetMessage ?? undefined,
        );

        if (responseSegments && responseSegments.length > 0) {
          await this.enqueueResponseSegments(channelId, responseSegments);

          // --- Mark the target message as responded to ---
          // If we had a specific target (from high score or LLM eval), mark it.
          if (finalTargetMessage) {
            contextManagerService.markMessageAsResponded(
              channelId,
              finalTargetMessage.id,
            );
          } else {
            // If it was a general response (ScoreDecision.Respond without specific target,
            // or LLM eval decided general response), we might not mark anything,
            // or potentially mark the last message in the *original batch*?
            // For now, let's only mark specifically targeted messages.
            loggerService.logger.debug(
              `General response sent for channel ${channelId}, no specific message marked as responded.`,
            );
          }
          // ---------------------------------------------
        } else {
          loggerService.logger.warn(
            `ResponderService did not generate a response for channel ${channelId}.`,
          );
        }
      }
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
      }
      return;
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
