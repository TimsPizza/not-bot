// src/context/index.ts
import configService from "@/config";
import { getDataStore, initializeDataStore } from "@/db/datastore";
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
  private contextMaxMessages = 20;
  private contextMaxAgeSeconds = 3600;
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

    try {
      const storeContext = getDataStore().getChannelContext(channelId);
      if (storeContext) {
        this.contextCache.set(channelId, storeContext);
        return storeContext;
      }
    } catch (error) {
      loggerService.logger.error(
        `Failed to read context for channel ${channelId} from SQLite: ${error}`,
      );
    }

    return null;
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

    let currentContext = this.contextCache.get(channelId);
    if (!currentContext) {
      currentContext = {
        serverId,
        channelId,
        messages: [],
        lastUpdatedAt: Date.now(),
      };
    }

    const updatedMessages = [...currentContext.messages, ...newMessages].filter(
      (msg) => msg.timestamp >= maxAgeTimestamp,
    );

    if (updatedMessages.length > maxMessages) {
      updatedMessages.splice(0, updatedMessages.length - maxMessages);
    }

    currentContext.messages = updatedMessages;
    currentContext.lastUpdatedAt = Date.now();
    this.contextCache.set(channelId, currentContext);

    try {
      getDataStore().setChannelContext(currentContext);
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to persist context",
      );
    }
  }

  public markMessageAsResponded(channelId: string, messageId: string): void {
    const context =
      this.contextCache.get(channelId) ??
      getDataStore().getChannelContext(channelId);

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
      getDataStore().setChannelContext(context);
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId, messageId },
        "Failed to persist responded context",
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
