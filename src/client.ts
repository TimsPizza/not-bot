// src/client.ts
import bufferQueueService from "@/buffer";
import configService from "@/config"; // Import class type
import contextManagerService from "@/context";
import llmEvaluatorService from "@/llm/llm_evaluator";
import responderService from "@/llm/responder";
import loggerService from "@/logger";
import scorerService from "@/scorer"; // Ensure this uses getDecisionForBatch
import {
  PersonaDefinition,
  PersonaType,
  ScoreDecision,
  SimpleMessage,
} from "@/types";
import {
  CacheType, // Added
  Channel,
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
      loggerService.logger.error("Discord client error:", error);
    });

    this.client.on(Events.Warn, (info) => {
      loggerService.logger.warn("Discord client warning:", info);
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
    if (!message.content || message.content.trim().length === 0) return; // Ignore empty messages or messages with only attachments
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
      // --- Get Persona and Prompt Template for Responder ---
      let systemPromptTemplate: string | undefined;
      let personaDefinition: PersonaDefinition | undefined;
      let personaDetails: string | undefined;
      const firstMessage = messages.length > 0 ? messages[0] : null; // Safely get first message

      if (firstMessage?.guildId || firstMessage?.channelId) {
        personaDefinition = configService.getPersonaDefinitionForContext(
          firstMessage.guildId ?? firstMessage.channelId, // DMs don't have a guildId, so use the channelId
          channelId,
        );
        const basePrompts = configService.getPersonaPrompts(); // Load base prompt templates
        systemPromptTemplate = basePrompts?.systemPrompt;
        personaDetails = personaDefinition?.details; // Get details from the resolved persona
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
          loggerService.logger.info(
            `Generating response targeting message ${finalTargetMessage.id}...`,
          );
        } else {
          loggerService.logger.info(
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

        // Pass the specific target message, template, and details to the responder
        const responseText = await responderService.generateResponse(
          channelId,
          systemPromptTemplate, // Already checked for existence
          personaDetails, // Already checked for existence
          finalTargetMessage ?? undefined,
        );

        if (responseText) {
          // Send the response
          await this.sendResponse(channelId, responseText);

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
  private async sendResponse(
    channelId: string,
    content: string,
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel instanceof TextChannel) {
        // Ensure it's a text channel
        // Typing indicator might have already been sent before LLM call
        // await channel.sendTyping();
        // Add a small delay to make typing seem more natural if needed
        // await new Promise((resolve) => setTimeout(resolve, Math.random() * 100 + 50));

        // Send the message and get the result to access its ID and timestamp
        const sentMessage = await channel.send(content);
        loggerService.logger.info(
          `Sent response to channel ${channelId}: "${content}" (ID: ${sentMessage.id})`,
        );

        // --- Add Bot's Own Response to Context ---
        // This is crucial for the bot to remember what it said
        if (this.botId && this.client.user) {
          // Ensure botId and client.user are available
          const botSimpleMessage: SimpleMessage = {
            id: sentMessage.id, // Use the actual ID of the sent message
            channelId: channelId,
            guildId: channel.guildId,
            authorId: this.botId,
            authorUsername: this.client.user.username, // Use actual bot username
            content: content,
            timestamp: sentMessage.createdTimestamp, // Use actual timestamp
            mentionedUsers: [],
            mentionedRoles: [],
            mentionsEveryone: false,
            isBot: true,
            respondedTo: true, // Mark bot's own message as 'responded' (it's the response itself)
            hasBeenRepliedTo: false, // 新增：用于总结功能
          };
          // Pass serverId (guildId) if available when adding bot's own message
          if (botSimpleMessage.guildId) {
            contextManagerService.updateContext(
              channelId,
              botSimpleMessage.guildId,
              [botSimpleMessage],
            );
            loggerService.logger.debug(
              `Added own response (ID: ${sentMessage.id}) to context for channel ${channelId}`,
            );
          } else {
            loggerService.logger.warn(
              `Could not determine guildId when adding bot response ${sentMessage.id} to context for channel ${channelId}.`,
            );
          }
        }
        // -----------------------------------------
      } else if (channel instanceof DMChannel) {
        // Handle DMs
        await channel.send(content);
        loggerService.logger.info(
          `Sent DM response to user in channel ${channelId}: "${content}"`,
        );
      } else {
        loggerService.logger.warn(
          `Cannot send response: Channel ${channelId} is not a text channel.`,
        );
      }
    } catch (error) {
      loggerService.logger.error(
        `Failed to send response to channel ${channelId}:`,
        error,
      );
    }
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

    const { commandName, options, guildId, channel, channelId } = interaction;
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

      const subcommand = options.getSubcommand(true);
      loggerService.logger.info(
        `Received config command '${subcommand}' from user ${interaction.user.tag} in guild ${guildId}`,
      );

      try {
        // Defer reply for potentially long operations
        await interaction.deferReply({ ephemeral: true }); // Ephemeral so only user sees config changes

        const serverConfig = configService.getServerConfig(
          guildId ?? channelId, // DMs don't have a guildId, so use the channelId
        ); // Get current or default config

        switch (subcommand) {
          case "channel": {
            const action = options.getString("action", true);
            const targetChannel = options.getChannel("channel") as Channel;

            // 如果没有指定频道，使用当前频道
            const channelToConfig = targetChannel || interaction.channel;

            if (
              !channelToConfig ||
              channelToConfig.type !== ChannelType.GuildText
            ) {
              await interaction.editReply(
                "Invalid channel. Please select a text channel or use this command in a text channel.",
              );
              return;
            }

            const channelId = channelToConfig.id;
            let allowed = serverConfig.allowedChannels || [];
            let message: string;

            switch (action) {
              case "enable":
                if (!allowed.includes(channelId)) {
                  allowed.push(channelId);
                  message = `Bot is now **enabled** in channel <#${channelId}>.`;
                } else {
                  message = `Bot is already enabled in channel <#${channelId}>.`;
                }
                break;
              case "disable":
                if (allowed.includes(channelId)) {
                  allowed = allowed.filter((id) => id !== channelId);
                  message = `Bot is now **disabled** in channel <#${channelId}>.`;
                } else {
                  message = `Bot is already disabled in channel <#${channelId}>.`;
                }
                break;
              case "toggle":
                if (allowed.includes(channelId)) {
                  allowed = allowed.filter((id) => id !== channelId);
                  message = `Bot is now **disabled** in channel <#${channelId}>.`;
                } else {
                  allowed.push(channelId);
                  message = `Bot is now **enabled** in channel <#${channelId}>.`;
                }
                break;
              default:
                await interaction.editReply("Invalid action specified.");
                return;
            }

            serverConfig.allowedChannels = allowed.length > 0 ? allowed : null;
            const success = await configService.saveServerConfig(serverConfig);
            await interaction.editReply(
              success ? message : "Failed to save configuration.",
            );
            break;
          }
          case "responsiveness": {
            const value = options.getNumber("value", true);
            serverConfig.responsiveness = value;
            const success = await configService.saveServerConfig(serverConfig);
            await interaction.editReply(
              success
                ? `Responsiveness set to **${value}**.`
                : "Failed to save configuration.",
            );
            break;
          }
          case "persona": {
            const action = options.getString("action", true);
            const targetChannel = options.getChannel("channel") as Channel;

            switch (action) {
              case "set": {
                const presetId = options.getString("persona", true);
                const presetPersona = configService.getPresetPersona(presetId);

                if (!presetPersona) {
                  await interaction.editReply(
                    `Error: Preset persona with ID '${presetId}' not found.`,
                  );
                  return;
                }

                let personaMessage: string;
                if (targetChannel) {
                  // 设置频道特定的角色
                  serverConfig.personaMappings[targetChannel.id] = {
                    type: PersonaType.Preset,
                    id: presetId,
                  };
                  personaMessage = `Persona for channel <#${targetChannel.id}> set to: **${presetPersona.name}** (ID: ${presetId}).`;
                } else {
                  // 设置服务器默认角色
                  serverConfig.personaMappings["default"] = {
                    type: PersonaType.Preset,
                    id: presetId,
                  };
                  personaMessage = `Default persona for this server set to: **${presetPersona.name}** (ID: ${presetId}).`;
                }

                const success =
                  await configService.saveServerConfig(serverConfig);
                await interaction.editReply(
                  success ? personaMessage : "Failed to save configuration.",
                );
                break;
              }
              case "list": {
                const availablePersonas =
                  configService.getAvailablePresetPersonas();
                const personaList = Array.from(availablePersonas.values())
                  .map(
                    (persona: PersonaDefinition) =>
                      `• **${persona.name}** (ID: \`${persona.id}\`) - ${persona.description}`,
                  )
                  .join("\n");

                await interaction.editReply(
                  `**Available Personas:**\n${personaList}`,
                );
                break;
              }
              default:
                await interaction.editReply(
                  "Invalid persona action specified.",
                );
                return;
            }
            break;
          }
          case "view": {
            // Format the current config for display
            const allowed = serverConfig.allowedChannels
              ? serverConfig.allowedChannels.map((id) => `<#${id}>`).join(", ")
              : "All Channels";
            // Display the default persona mapping
            const defaultMapping = serverConfig.personaMappings["default"];
            let personaInfo = "Not Set";
            if (defaultMapping) {
              personaInfo = `Type: ${defaultMapping.type}, ID: ${defaultMapping.id}`;
              // Optionally load and display name/description if needed
            }

            const configView =
              `**Current Server Configuration:**\n` +
              `- Allowed Channels: ${allowed}\n` +
              `- Responsiveness: ${serverConfig.responsiveness}\n` +
              `- Default Persona Mapping: ${personaInfo}`;
            // TODO: Add display for channel-specific mappings if implemented
            await interaction.editReply(configView);
            break;
          }
          default:
            await interaction.editReply("Unknown configuration command.");
        }
      } catch (error: any) {
        loggerService.logger.error(
          `Error handling '/config ${subcommand}' interaction:`,
          error,
        );
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(
            "An error occurred while processing the command.",
          );
        } else {
          await interaction.reply({
            content: "An error occurred while processing the command.",
            ephemeral: true,
          });
        }
      }
    }

    // Handle other commands if added later
  }
}

export default BotClient;
