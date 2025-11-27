// src/context/index.ts
import configService from "@/config";
import {
  getRecentMessages as fetchRecentMessagesFromDb,
  initializeDataStore,
  markMessageResponded as markMessageRespondedInDb,
  persistMessages,
} from "@/db/datastore";
import loggerService from "@/logger";
import {
  AppConfig,
  ChannelContext,
  ServerConfig,
  SimpleMessage,
} from "@/types";
import QuickLRU from "quick-lru";

class ContextManagerService {
  private static instance: ContextManagerService;

  private contextCache = new QuickLRU<string, ChannelContext>({ maxSize: 500 });
  private serverDataPath: string | null = null;
  private contextMaxMessages = 200;
  private contextMaxAgeSeconds = 60 * 60 * 24 * 7; // 7 days
  private isInitialized = false;

  private constructor() {
    this.initialize();
  }

  public static getInstance(): ContextManagerService {
    if (!ContextManagerService.instance) {
      ContextManagerService.instance = new ContextManagerService();
    }
    return ContextManagerService.instance;
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));

      const config = configService.getConfig();
      this.serverDataPath = config.serverDataPath;
      this.contextMaxMessages = config.contextMaxMessages;
      this.contextMaxAgeSeconds = config.contextMaxAgeSeconds;

      if (!this.serverDataPath) {
        loggerService.logger.error(
          "SERVER_DATA_PATH is not defined in configuration. Context persistence disabled.",
        );
        this.isInitialized = true;
        return;
      }

      initializeDataStore(this.serverDataPath);

      this.isInitialized = true;
      loggerService.logger.info("ContextManagerService initialized.");
    } catch (error: any) {
      loggerService.logger.error(
        `Failed to initialize ContextManagerService: ${error.message}`,
      );
      this.isInitialized = true;
    }
  }

  public getContext(channelId: string): ChannelContext | null {
    const cached = this.contextCache.get(channelId);
    if (cached) {
      return cached;
    }

    const maxMessages = this.contextMaxMessages;
    const minTimestamp = Date.now() - this.contextMaxAgeSeconds * 1000;

    try {
      const recentMessages = fetchRecentMessagesFromDb(
        channelId,
        maxMessages,
        minTimestamp,
      );

      if (!recentMessages.length) {
        return null;
      }

      const context: ChannelContext = {
        serverId: recentMessages[0]?.guildId ?? "DM",
        channelId,
        messages: recentMessages,
        lastUpdatedAt:
          recentMessages[recentMessages.length - 1]?.timestamp ?? Date.now(),
      };
      this.contextCache.set(channelId, context);
      return context;
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to load context from structured storage",
      );
      return null;
    }
  }

  public updateContext(
    channelId: string,
    serverId: string,
    newMessages: SimpleMessage[],
  ): void {
    if (!serverId) {
      loggerService.logger.error(
        `Cannot update context for channel ${channelId}: serverId is missing.`,
      );
      return;
    }
    if (!newMessages || newMessages.length === 0) {
      return;
    }

    const serverConfig = configService.getServerConfig(serverId);
    const maxMessages =
      serverConfig.maxContextMessages ?? this.contextMaxMessages;
    const maxAgeSeconds = this.contextMaxAgeSeconds;
    const maxAgeTimestamp = Date.now() - maxAgeSeconds * 1000;

    try {
      persistMessages({
        channelId,
        serverId: serverId === "DM" ? null : serverId,
        type: serverId === "DM" ? "dm" : "guild_text",
        ownerUserId:
          serverId === "DM" ? (newMessages[0]?.authorId ?? null) : null,
        messages: newMessages,
      });
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to persist messages for context",
      );
      return;
    }

    const recentMessages = fetchRecentMessagesFromDb(
      channelId,
      maxMessages,
      maxAgeTimestamp,
    );

    const context: ChannelContext = {
      serverId,
      channelId,
      messages: recentMessages,
      lastUpdatedAt: Date.now(),
    };

    this.contextCache.set(channelId, context);
  }

  public markMessageAsResponded(channelId: string, messageId: string): void {
    const context =
      this.contextCache.get(channelId) ?? this.getContext(channelId);

    if (!context) {
      loggerService.logger.warn(
        `Attempted to mark message in non-existent context for channel ${channelId}`,
      );
      return;
    }

    const messageIndex = context.messages.findIndex(
      (msg) => msg.id === messageId,
    );
    if (messageIndex === -1) {
      loggerService.logger.warn(
        `Attempted to mark non-existent message ${messageId} in context for channel ${channelId}`,
      );
      return;
    }

    context.messages[messageIndex]!.respondedTo = true;
    context.lastUpdatedAt = Date.now();
    this.contextCache.set(channelId, context);

    try {
      markMessageRespondedInDb(channelId, messageId);
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId, messageId },
        "Failed to mark message responded in datastore",
      );
    }
  }

  public async flushAllContextsToDisk(): Promise<void> {
    loggerService.logger.info(
      "Context flush requested — contexts persist to SQLite immediately; nothing further required.",
    );
  }

  public getContextMaxMessages(config?: ServerConfig | AppConfig): number {
    if (!config) {
      return this.contextMaxMessages;
    }
    return (
      (config as ServerConfig).maxContextMessages ?? this.contextMaxMessages
    );
  }
}

const contextManagerService = ContextManagerService.getInstance();
export default contextManagerService;
export { ContextManagerService };
