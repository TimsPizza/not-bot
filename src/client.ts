// src/client.ts
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
} from "discord.js";
import loggerService from "@/logger";
import configService from "@/config";
import contextManagerService from "@/context";
import bufferQueueService from "@/buffer";
import scorerService from "@/scorer"; // Ensure this uses getDecisionForBatch
import llmEvaluatorService from "@/llm/llm_evaluator";
import responderService from "@/llm/responder";
import { SimpleMessage, ScoreDecision } from "@/types";

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
    if (!message.content || message.content.trim().length === 0) return; // Ignore empty messages or messages with only attachments
    if (!this.botId) {
      // Ensure botId is set (should be after ClientReady)
      loggerService.logger.warn("Bot ID not set yet, ignoring message.");
      return;
    }

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
      respondedTo: false // Initialize as false (optional, default is undefined)
    };

    // 3. Update Context (do this regardless of buffering/scoring)
    contextManagerService.updateContext(simpleMessage.channelId, [
      simpleMessage,
    ]);

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
        scoringResults.forEach(r => {
            if (r.score > highestScore) {
                highestScore = r.score;
                highestScoringMsgId = r.messageId;
            }
        });
        finalTargetMessage = messages.find(msg => msg.id === highestScoringMsgId) || null;
        if (finalTargetMessage) {
             loggerService.logger.debug(`Highest scoring message in batch (ID: ${finalTargetMessage.id}) identified for potential marking.`);
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

        // Pass both the current batch and the channel context to the evaluator
        const evaluationResult = await llmEvaluatorService.evaluateMessages(
          messages,
          channelContextMessages,
        ); // Pass both arguments

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
         loggerService.logger.warn(`Failed to send typing indicator to channel ${channelId}: ${typingError}`);
      }

      // Pass the specific target message to the responder if available
      const responseText = await responderService.generateResponse(
        channelId,
        finalTargetMessage ?? undefined, // Pass target message or undefined
      );

      if (responseText) {
        // Send the response
        await this.sendResponse(channelId, responseText);

        // --- Mark the target message as responded to ---
        // If we had a specific target (from high score or LLM eval), mark it.
        if (finalTargetMessage) {
          contextManagerService.markMessageAsResponded(channelId, finalTargetMessage.id);
        } else {
          // If it was a general response (ScoreDecision.Respond without specific target,
          // or LLM eval decided general response), we might not mark anything,
          // or potentially mark the last message in the *original batch*?
          // For now, let's only mark specifically targeted messages.
          loggerService.logger.debug(`General response sent for channel ${channelId}, no specific message marked as responded.`);
        }
        // ---------------------------------------------

      } else {
        loggerService.logger.warn(
          `ResponderService did not generate a response for channel ${channelId}.`,
        );
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
            respondedTo: true // Mark bot's own message as 'responded' (it's the response itself)
          };
          contextManagerService.updateContext(channelId, [botSimpleMessage]);
          loggerService.logger.debug(
            `Added own response (ID: ${sentMessage.id}) to context for channel ${channelId}`,
          );
        }
        // -----------------------------------------
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
}

export default BotClient;
