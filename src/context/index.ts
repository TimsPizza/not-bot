// src/context/index.ts
import fs from "fs/promises"; // Use promises for async operations
import path from "path";
import loggerService from "@/logger";
import configService from "@/config"; // Import config service instance
import {
  SimpleMessage,
  ChannelContext,
  AppConfig,
  ServerConfig,
} from "@/types"; // Added ServerConfig
import fsExtra from "fs-extra"; // Use fs-extra for ensureDir

class ContextManagerService {
  private static instance: ContextManagerService;

  // In-memory cache for active contexts <channelId, ChannelContext>
  private contextCache = new Map<string, ChannelContext>();

  private serverDataPath: string | null = null; // Base path for all server data
  private contextMaxMessages: number = 20; // Global default
  private contextMaxAgeSeconds: number = 3600; // Global default
  private isInitialized = false;

  private constructor() {
    // Initialization logic moved to an async method to handle promises
    this.initialize();
  }

  /**
   * @description Gets the singleton instance of the ContextManagerService.
   * @returns {ContextManagerService} The singleton instance.
   */
  public static getInstance(): ContextManagerService {
    if (!ContextManagerService.instance) {
      ContextManagerService.instance = new ContextManagerService();
    }
    return ContextManagerService.instance;
  }

  /**
   * @description Initializes the ContextManager, ensuring storage path exists.
   * Called internally by the constructor.
   */
  private async initialize(): Promise<void> {
    // Prevent multiple initializations
    if (this.isInitialized) return;

    try {
      // Wait briefly for config service to potentially finish its initial load,
      // though ideally dependency injection or async init patterns are better.
      // For simplicity here, we assume config is ready shortly after app start.
      await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay

      const config = configService.getConfig(); // Get global config from the service
      this.serverDataPath = config.serverDataPath; // Get the base path for server data
      this.contextMaxMessages = config.contextMaxMessages; // Keep global defaults
      this.contextMaxAgeSeconds = config.contextMaxAgeSeconds; // Keep global defaults

      if (!this.serverDataPath) {
        loggerService.logger.error(
          "SERVER_DATA_PATH is not defined in configuration. Disk persistence for context disabled.",
        );
        this.isInitialized = true; // Mark as initialized even if path is missing
        return;
      }

      // Ensure the base server data path exists (individual server dirs created on demand)
      await fsExtra.ensureDir(this.serverDataPath);
      loggerService.logger.info(
        `Base server data directory ensured: ${this.serverDataPath}`,
      );

      // Load existing contexts from disk on startup
      await this.loadAllContextsFromDisk();

      this.isInitialized = true;
      loggerService.logger.info("ContextManagerService initialized.");
    } catch (error: any) {
      loggerService.logger.error(
        `Failed to initialize ContextManagerService: ${error.message}`,
      );
      this.serverDataPath = null; // Disable disk operations if init fails
      this.isInitialized = true; // Mark as initialized even on error to prevent retries
    }
  }

  /**
   * @description Retrieves the context for a given channel ID.
   * @param channelId The ID of the channel.
   * @returns The ChannelContext object or null if not found.
   */
  public getContext(channelId: string): ChannelContext | null {
    // TODO: Implement loading from disk if not in cache and initialization succeeded?
    return this.contextCache.get(channelId) || null;
  }

  /**
   * @description Updates the context for a given channel ID with new messages.
   * Applies FIFO logic based on max messages and max age (potentially server-specific).
   * @param channelId The ID of the channel.
   * @param serverId The ID of the server (guild) this channel belongs to. Required for storage path.
   * @param newMessages An array of new SimpleMessage objects to add.
   */
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

    // --- Get Server-Specific Limits (or use global defaults) ---
    const serverConfig = configService.getServerConfig(serverId);
    const maxMessages =
      serverConfig.maxContextMessages ?? this.contextMaxMessages;
    // TODO: Implement server-specific max age if needed, currently using global
    const maxAgeSeconds = this.contextMaxAgeSeconds;
    // ---

    const now = Date.now();
    const maxAgeTimestamp = now - maxAgeSeconds * 1000;

    let currentContext = this.contextCache.get(channelId);

    if (!currentContext) {
      // Ensure serverId is included when creating new context
      currentContext = {
        serverId: serverId, // Store serverId
        channelId: channelId,
        messages: [],
        lastUpdatedAt: now,
      };
    } else {
      // Ensure existing context has serverId (for contexts loaded before this change)
      if (!currentContext.serverId) {
        currentContext.serverId = serverId;
      }
    }

    // Add new messages and filter out old ones
    const updatedMessages = [...currentContext.messages, ...newMessages].filter(
      (msg) => msg.timestamp >= maxAgeTimestamp,
    ); // Filter by age

    // Apply max message limit (FIFO) using potentially server-specific limit
    if (updatedMessages.length > maxMessages) {
      updatedMessages.splice(0, updatedMessages.length - maxMessages);
    }

    currentContext.messages = updatedMessages;
    currentContext.lastUpdatedAt = now;
    this.contextCache.set(channelId, currentContext);

    // TODO: Implement smarter flushing logic (e.g., periodic, on size threshold, on shutdown)
  }

  /**
   * @description Marks a specific message within a channel's context as having been responded to.
   * @param channelId The ID of the channel containing the message.
   * @param messageId The ID of the message to mark.
   */
  public markMessageAsResponded(channelId: string, messageId: string): void {
    const context = this.contextCache.get(channelId);
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

    // Update the message object directly in the cache
    context.messages[messageIndex]!.respondedTo = true;
    context.lastUpdatedAt = Date.now(); // Update timestamp as context changed

    loggerService.logger.debug(
      `Marked message ${messageId} in channel ${channelId} as respondedTo.`,
    );

    // Optionally trigger a save to disk here if immediate persistence is needed
    // this.saveContextToDisk(channelId, context);
  }

  /**
   * @description Manually triggers flushing all cached contexts to disk.
   */
  public async flushAllContextsToDisk(): Promise<void> {
    if (!this.isInitialized) {
      loggerService.logger.warn(
        "ContextManagerService not initialized. Skipping flush.",
      );
      return;
    }
    if (!this.serverDataPath) {
      loggerService.logger.warn(
        "SERVER_DATA_PATH not configured. Skipping flush to disk.",
      );
      return;
    }

    loggerService.logger.info(
      `Flushing ${this.contextCache.size} contexts to disk under ${this.serverDataPath}...`,
    );
    const flushPromises: Promise<void>[] = [];

    for (const [channelId, context] of this.contextCache.entries()) {
      flushPromises.push(this.saveContextToDisk(channelId, context)); // Use helper
    }

    try {
      await Promise.all(flushPromises);
      loggerService.logger.info("Finished flushing contexts to disk.");
    } catch (error) {
      loggerService.logger.error(
        "An error occurred during the context flushing process.",
        error,
      );
    }
  }

  /**
   * @description Saves a single channel's context to a JSON file.
   * @param channelId The channel ID.
   * @param context The ChannelContext object (must include serverId).
   */
  private async saveContextToDisk(
    channelId: string,
    context: ChannelContext,
  ): Promise<void> {
    if (!this.serverDataPath || !context.serverId) {
      loggerService.logger.error(
        `Cannot save context for channel ${channelId}: serverDataPath or context.serverId is missing.`,
      );
      return;
    }

    const serverContextPath = path.join(
      this.serverDataPath,
      context.serverId,
      "context",
    );
    const filePath = path.join(serverContextPath, `${channelId}.json`);
    const fileContent = JSON.stringify(context, null, 2); // Pretty print JSON

    try {
      await fsExtra.ensureDir(serverContextPath); // Ensure server's context directory exists
      await fs.writeFile(filePath, fileContent, "utf8");
      loggerService.logger.debug(
        `Context for channel ${channelId} (Server: ${context.serverId}) saved to ${filePath}`,
      );
    } catch (err) {
      loggerService.logger.error(
        `Failed to save context for channel ${channelId} (Server: ${context.serverId}) to ${filePath}: ${err}`,
      );
      // Optionally re-throw or handle specific errors
    }
  }

  /**
   * @description Loads all context files from the server data directory structure into the cache.
   */
  private async loadAllContextsFromDisk(): Promise<void> {
    if (!this.serverDataPath) {
      return; // Path not configured
    }
    loggerService.logger.info(
      `Scanning for contexts under: ${this.serverDataPath}`,
    );
    let totalLoadedCount = 0;
    try {
      const serverDirs = await fs.readdir(this.serverDataPath, {
        withFileTypes: true,
      });

      for (const serverDir of serverDirs) {
        if (serverDir.isDirectory()) {
          const serverId = serverDir.name;
          const serverContextPath = path.join(
            this.serverDataPath,
            serverId,
            "context",
          );

          if (fsExtra.existsSync(serverContextPath)) {
            loggerService.logger.debug(
              `Loading contexts for server ${serverId} from ${serverContextPath}`,
            );
            try {
              const files = await fs.readdir(serverContextPath);
              const jsonFiles = files.filter((file) => file.endsWith(".json"));
              let serverLoadedCount = 0;
              const now = Date.now();
              const maxAgeTimestamp = now - this.contextMaxAgeSeconds * 1000;

              for (const file of jsonFiles) {
                const filePath = path.join(serverContextPath, file);
                try {
                  const fileContent = await fs.readFile(filePath, "utf8");
                  const context = JSON.parse(fileContent) as ChannelContext;

                  // Validate loaded context structure
                  if (
                    context &&
                    context.channelId &&
                    Array.isArray(context.messages)
                  ) {
                    // Ensure serverId matches directory (or add it if missing from older format)
                    context.serverId = serverId;

                    // Filter old messages on load
                    context.messages = context.messages.filter(
                      (msg) => msg.timestamp >= maxAgeTimestamp,
                    );

                    // Ensure context isn't empty after filtering before caching
                    if (context.messages.length > 0) {
                      this.contextCache.set(context.channelId, context);
                      serverLoadedCount++;
                    } else {
                      loggerService.logger.debug(
                        `Context file ${filePath} contained only expired messages. Not loaded.`,
                      );
                      // Optionally delete the empty context file
                      // fs.unlink(filePath).catch(err => loggerService.logger.warn(`Failed to delete empty context file ${filePath}: ${err}`));
                    }
                  } else {
                    loggerService.logger.warn(
                      `Skipping invalid context file: ${filePath}`,
                    );
                  }
                } catch (readError) {
                  loggerService.logger.error(
                    `Failed to read or parse context file ${filePath}: ${readError}`,
                  );
                }
              }
              if (serverLoadedCount > 0) {
                loggerService.logger.info(
                  `Loaded ${serverLoadedCount} non-empty contexts for server ${serverId}.`,
                );
                totalLoadedCount += serverLoadedCount;
              }
            } catch (serverReadError) {
              loggerService.logger.error(
                `Failed to read context directory for server ${serverId} at ${serverContextPath}: ${serverReadError}`,
              );
            }
          }
        }
      }
      loggerService.logger.info(
        `Finished loading contexts. Total loaded: ${totalLoadedCount}.`,
      );
    } catch (error: any) {
      if (error.code === "ENOENT") {
        loggerService.logger.info(
          "Base server data directory does not exist yet. No contexts loaded.",
        );
      } else {
        loggerService.logger.error(
          `Failed to read base server data directory ${this.serverDataPath}: ${error}`,
        );
      }
    }
  }
}

// Export the singleton instance directly
const contextManagerService = ContextManagerService.getInstance();
export default contextManagerService; // Export the instance
export { ContextManagerService }; // Export the class type if needed elsewhere
