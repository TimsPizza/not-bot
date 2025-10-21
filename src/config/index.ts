// src/config/index.ts
import fs from "fs-extra"; // Use fs-extra for ensureDirSync etc.
import path from "path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import loggerService from "@/logger"; // Import logger service instance
import {
  AppConfig,
  PersonaPrompts,
  ServerConfig,
  PersonaDefinition,
  PersonaPreset,
  PersonaRef,
  PersonaType,
} from "@/types"; // Updated imports
import {
  initializeDataStore,
  getServerConfig as loadServerConfigFromDb,
  ensureServerConfig as ensureServerConfigInDb,
  upsertServerConfig as persistServerConfig,
  bulkUpsertBuiltins,
  getPersonaById as fetchPersonaById,
  listBuiltInPersonas,
} from "@/db/datastore";

class ConfigService {
  private static instance: ConfigService;

  private currentConfig: AppConfig | null = null;
  private currentPersonaPrompts: PersonaPrompts | null = null; // Base prompt templates
  private serverConfigs: Map<string, ServerConfig> = new Map(); // Cache for server configs <serverId, ServerConfig>
  private presetPersonas: Map<string, PersonaDefinition> = new Map(); // Cache for preset personas <presetId, PersonaDefinition>
  private dataStoreInitialized = false;

  private mainConfigPath: string = "";
  private serverDataPath: string = ""; // Base path for server data
  private presetPersonasPath: string = ""; // Path to preset personas
  // Store watchers to potentially close them later if needed, though fs.watch is tricky
  private fileWatchers: fs.FSWatcher[] = [];

  private constructor() {
    dotenv.config(); // Load .env file first

    // Load paths from environment variables first, providing defaults
    this.mainConfigPath =
      process.env.CONFIG_FILE_PATH ||
      path.resolve(process.cwd(), "config", "config.yaml");
    this.serverDataPath =
      process.env.SERVER_DATA_PATH || path.resolve(process.cwd(), "data");
    this.presetPersonasPath =
      process.env.PRESET_PERSONAS_PATH ||
      path.resolve(process.cwd(), "personas");

    this.initializeConfig(); // Load configuration during instantiation
  }

  /**
   * @description Gets the singleton instance of the ConfigService.
   * @returns {ConfigService} The singleton instance.
   */
  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  // --- Public Accessors ---

  /**
   * @description Gets the current application configuration. Throws error if not loaded.
   * @returns {AppConfig} The current configuration object.
   */
  public getConfig(): AppConfig {
    if (!this.currentConfig) {
      loggerService.logger.error(
        "CRITICAL: Attempted to access config before initialization.",
      );
      throw new Error("Configuration not initialized.");
    }
    return this.currentConfig;
  }

  /**
   * @description Gets the current persona prompts. Returns null if not loaded.
   * @returns {PersonaPrompts | null} The current persona prompts object or null.
   */
  public getPersonaPrompts(): PersonaPrompts | null {
    return this.currentPersonaPrompts; // Base templates
  }

  /**
   * @description Gets a specific loaded preset persona by its ID.
   * @param presetId The ID of the preset persona (filename without extension).
   * @returns {PersonaDefinition | undefined} The persona definition or undefined if not found.
   */
  public getPresetPersona(presetId: string): PersonaDefinition | undefined {
    const cached = this.presetPersonas.get(presetId);
    if (cached) {
      return cached;
    }

    const record = fetchPersonaById(presetId);
    if (record && record.scope === "builtin") {
      const persona: PersonaDefinition = {
        id: record.id,
        name: record.name,
        description: record.description,
        details: record.details,
      };
      this.presetPersonas.set(presetId, persona);
      return persona;
    }

    return undefined;
  }

  /**
   * @description Gets a map of all available preset personas.
   * @returns {Map<string, PersonaDefinition>} A map where keys are preset IDs and values are PersonaDefinition objects.
   */
  public getAvailablePresetPersonas(): Map<string, PersonaDefinition> {
    return this.presetPersonas;
  }

  /**
   * @description Gets the active PersonaDefinition for a given server and channel context.
   * It checks for channel-specific mapping first, then server default mapping.
   * It loads the definition from presets or the server's custom persona directory.
   * @param serverId The ID of the server.
   * @param channelId The ID of the channel.
   * @returns {PersonaDefinition | undefined} The resolved persona definition, or undefined if not found/error.
   */
  public getPersonaDefinitionForContext(
    serverId: string,
    channelId: string,
  ): PersonaDefinition | undefined {
    const serverConfig = this.getServerConfig(serverId);

    // Determine the relevant PersonaRef (channel specific or default)
    const personaRef =
      serverConfig.personaMappings[channelId] ??
      serverConfig.personaMappings["default"];

    if (!personaRef) {
      loggerService.logger.error(
        `No persona mapping found for server ${serverId}, channel ${channelId}, or default.`,
      );
      // Fallback to trying the hardcoded 'default' preset if mapping is somehow missing
      return this.getPresetPersona("default");
    }

    loggerService.logger.debug(
      `Resolved PersonaRef for ${serverId}/${channelId}: type=${personaRef.type}, id=${personaRef.id}`,
    );

    // Load based on type
    const personaRecord = fetchPersonaById(personaRef.id);

    if (!personaRecord) {
      loggerService.logger.warn(
        `Persona '${personaRef.id}' referenced by server ${serverId} not found in database. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    }

    if (
      personaRef.type === PersonaType.Custom &&
      personaRecord.scope !== "custom"
    ) {
      loggerService.logger.warn(
        `Persona '${personaRef.id}' expected to be custom but scope is '${personaRecord.scope}'. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    }

    if (
      personaRef.type === PersonaType.Custom &&
      personaRecord.serverId !== serverId
    ) {
      loggerService.logger.warn(
        `Custom persona '${personaRef.id}' does not belong to server ${serverId}. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    }

    if (
      personaRef.type === PersonaType.Preset &&
      personaRecord.scope !== "builtin"
    ) {
      loggerService.logger.warn(
        `Persona '${personaRef.id}' expected to be builtin but scope is '${personaRecord.scope}'. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    }

    return {
      id: personaRecord.id,
      name: personaRecord.name,
      description: personaRecord.description,
      details: personaRecord.details,
    };
  }

  /**
   * @description Gets the configuration for a specific server, loading if necessary.
   * Falls back to defaults if the server has no specific config file or it's invalid.
   * @param serverId The Discord Guild ID.
   * @returns {ServerConfig} The server's configuration.
   */
  public getServerConfig(serverId: string): ServerConfig {
    this.ensureDataStore();

    if (this.serverConfigs.has(serverId)) {
      return this.serverConfigs.get(serverId)!;
    }

    let loadedConfig = loadServerConfigFromDb(serverId);
    if (!loadedConfig) {
      loadedConfig = ensureServerConfigInDb(serverId);
    }

    const normalized = this.normalizeServerConfigValues(loadedConfig);
    this.serverConfigs.set(serverId, normalized);
    return normalized;
  }

  /**
   * @description Saves a server's configuration to its JSON file.
   * @param serverConfig The ServerConfig object to save.
   * @returns {Promise<boolean>} True if successful, false otherwise.
   */
  public async saveServerConfig(serverConfig: ServerConfig): Promise<boolean> {
    this.ensureDataStore();
    try {
      const normalized = this.normalizeServerConfigValues(serverConfig);
      persistServerConfig(normalized);
      this.serverConfigs.set(serverConfig.serverId, normalized);
      loggerService.logger.info(
        `Persisted server config for ${serverConfig.serverId} through SQLite store.`,
      );
      return true;
    } catch (error: any) {
      loggerService.logger.error(
        `Error saving server config for ${serverConfig.serverId}: ${error.message}`,
      );
      return false;
    }
  }

  // --- Private Loading and Reloading Logic ---

  /**
   * @description Generates a default ServerConfig object for a given server ID.
   * @param serverId The Discord Guild ID.
   * @returns {ServerConfig} The default server configuration.
   */
  private getDefaultServerConfig(serverId: string): ServerConfig {
    // Default config points to the 'default' preset persona
    const defaultPersonaRef: PersonaRef = {
      type: PersonaType.Preset,
      id: "default",
    };
    return {
      serverId: serverId,
      allowedChannels: null,
      responsiveness: 1.0,
      personaMappings: {
        default: defaultPersonaRef, // Default mapping for the server
      },
      languageConfig: {
        primary: "auto" as any,
        fallback: "en" as any,
        autoDetect: true,
      },
      // maxContextMessages: undefined,
      // maxDailyResponses: undefined,
    };
  }

  /**
   * @description Loads all valid persona definition files from the preset personas directory.
   */
  private loadPresetPersonas(): void {
    this.ensureDataStore();

    if (!this.presetPersonasPath) {
      loggerService.logger.warn(
        `PRESET_PERSONAS_PATH is not defined. Cannot load preset personas.`,
      );
      const persisted = listBuiltInPersonas();
      this.presetPersonas = new Map(
        persisted.map((persona) => [
          persona.id,
          {
            id: persona.id,
            name: persona.name,
            description: persona.description,
            details: persona.details,
          },
        ]),
      );
      return;
    }
    if (!fs.existsSync(this.presetPersonasPath)) {
      loggerService.logger.warn(
        `Preset personas directory not found: ${this.presetPersonasPath}. No preset personas loaded.`,
      );
      const persisted = listBuiltInPersonas();
      this.presetPersonas = new Map(
        persisted.map((persona) => [
          persona.id,
          {
            id: persona.id,
            name: persona.name,
            description: persona.description,
            details: persona.details,
          },
        ]),
      );
      return;
    }

    loggerService.logger.info(
      `Loading preset personas from: ${this.presetPersonasPath}`,
    );
    const loadedPersonas = new Map<string, PersonaDefinition>();
    try {
      const files = fs.readdirSync(this.presetPersonasPath);
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(this.presetPersonasPath, file);
        const personaId = path.basename(file, ".json");
        try {
          const fileContent = fs.readFileSync(filePath, "utf-8");
          const personaData = JSON.parse(
            fileContent,
          ) as Partial<PersonaDefinition>;

          if (
            personaData.name &&
            personaData.description &&
            personaData.details
          ) {
            const finalId =
              personaData.id && personaData.id !== personaId
                ? personaData.id
                : personaId;

            if (loadedPersonas.has(finalId)) {
              loggerService.logger.warn(
                `Duplicate preset persona ID '${finalId}' found. Skipping ${file}.`,
              );
              continue;
            }

            loadedPersonas.set(finalId, {
              id: finalId,
              name: personaData.name,
              description: personaData.description,
              details: personaData.details,
            });
          } else {
            loggerService.logger.warn(
              `Invalid persona structure in file ${file}. Skipping.`,
            );
          }
        } catch (error: any) {
          loggerService.logger.error(
            `Error loading or parsing preset persona file ${filePath}: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      loggerService.logger.error(
        `Error reading preset personas directory ${this.presetPersonasPath}: ${error.message}`,
      );
    }

    if (loadedPersonas.size > 0) {
      bulkUpsertBuiltins(Array.from(loadedPersonas.values()));
    }

    const persistedBuiltins = listBuiltInPersonas();
    this.presetPersonas = new Map(
      persistedBuiltins.map((persona) => [
        persona.id,
        {
          id: persona.id,
          name: persona.name,
          description: persona.description,
          details: persona.details,
        },
      ]),
    );

    if (!this.presetPersonas.has("default")) {
      loggerService.logger.error(
        "CRITICAL: Default preset persona ('default.json') not found or failed to load. Bot may not function correctly.",
      );
    }
  }

  private initializeConfig(): void {
    loggerService.logger.info("Initializing configuration...");
    const mainConfig = this.loadMainConfig(this.mainConfigPath);

    if (!mainConfig) {
      loggerService.logger.error(
        "CRITICAL: Failed to load main configuration. Exiting.",
      );
      process.exit(1);
    }
    this.currentConfig = mainConfig;
    // serverDataPath and presetPersonasPath are loaded in the constructor from env vars
    loggerService.updateLogLevel(this.currentConfig.logLevel);

    // Ensure server data and preset persona directories exist
    try {
      if (this.serverDataPath) {
        fs.ensureDirSync(this.serverDataPath);
        loggerService.logger.info(
          `Server data directory ensured: ${this.serverDataPath}`,
        );
      } else {
        loggerService.logger.error(
          "SERVER_DATA_PATH is not defined. Server-specific configurations cannot be loaded or saved.",
        );
        // Potentially throw an error or exit if this path is critical
      }
      if (this.presetPersonasPath) {
        fs.ensureDirSync(this.presetPersonasPath);
        loggerService.logger.info(
          `Preset personas directory ensured: ${this.presetPersonasPath}`,
        );
      } else {
        loggerService.logger.warn(
          "PRESET_PERSONAS_PATH is not defined. Preset personas cannot be loaded.",
        );
      }
    } catch (error: any) {
      loggerService.logger.error(
        `Failed to ensure data/persona directories exist: ${error.message}`,
      );
      // Decide if this is critical enough to exit? For now, just log.
    }

    if (this.currentConfig.personaPromptFile) {
      this.currentPersonaPrompts = this.loadPersonaPrompts(
        this.currentConfig.personaPromptFile,
      );
    } else {
      loggerService.logger.error(
        "Persona prompt file path not defined in main config.",
      );
    }

    // Load available preset personas after main config is loaded
    this.loadPresetPersonas();

    this.setupWatchers();
    // TODO: Add watcher for preset personas directory? Reloading personas might be complex.
    loggerService.logger.info(
      "Configuration initialized and watchers started.",
    );
  }

  private setupWatchers(): void {
    // Clear existing watchers if any (though stopping fs.watch is unreliable)
    this.fileWatchers.forEach((watcher) => watcher.close());
    this.fileWatchers = [];

    this.watchFile(this.mainConfigPath, this.reloadMainConfig.bind(this));
    if (this.currentConfig?.personaPromptFile) {
      this.watchFile(
        this.currentConfig.personaPromptFile,
        this.reloadPersonaPrompts.bind(this),
      );
    }
  }

  private loadMainConfig(filePath: string): AppConfig | null {
    try {
      loggerService.logger.info(
        `Attempting to load main config from: ${filePath}`,
      );
      if (!fs.existsSync(filePath)) {
        loggerService.logger.error(
          `Main config file not found at: ${filePath}`,
        );
        return null;
      }
      const fileContents = fs.readFileSync(filePath, "utf8");
      // Load base config from YAML as a partial object
      const configFromFile = yaml.load(fileContents) as Partial<AppConfig>;

      // --- Construct final config, prioritizing environment variables ---
      const finalConfig: Partial<AppConfig> = {
        // Discord Token
        discordToken:
          process.env.DISCORD_BOT_TOKEN || configFromFile.discordToken,

        // Primary LLM
        primaryLlmApiKey:
          process.env.OPENAI_PRIMARY_API_KEY || configFromFile.primaryLlmApiKey,
        primaryLlmBaseUrl:
          process.env.OPENAI_PRIMARY_BASE_URL ||
          configFromFile.primaryLlmBaseUrl ||
          "https://api.openai.com/v1", // Default OpenAI URL
        primaryLlmModel:
          process.env.OPENAI_PRIMARY_MODEL || configFromFile.primaryLlmModel,

        // Secondary LLM
        secondaryLlmApiKey:
          process.env.OPENAI_SECONDARY_API_KEY ||
          configFromFile.secondaryLlmApiKey,
        secondaryLlmBaseUrl:
          process.env.OPENAI_SECONDARY_BASE_URL ||
          configFromFile.secondaryLlmBaseUrl ||
          "https://api.openai.com/v1", // Default OpenAI URL
        secondaryLlmModel:
          process.env.OPENAI_SECONDARY_MODEL ||
          configFromFile.secondaryLlmModel,

        // Bot Behavior (use defaults if not in env or file)
        bufferSize:
          parseInt(process.env.BUFFER_SIZE || "", 10) ||
          configFromFile.bufferSize ||
          10,
        bufferTimeWindowMs:
          parseInt(process.env.BUFFER_TIME_WINDOW_MS || "", 10) ||
          configFromFile.bufferTimeWindowMs ||
          2000,
        contextMaxMessages:
          parseInt(process.env.CONTEXT_MAX_MESSAGES || "", 10) ||
          configFromFile.contextMaxMessages ||
          20,
        contextMaxAgeSeconds:
          parseInt(process.env.CONTEXT_MAX_AGE_SECONDS || "", 10) ||
          configFromFile.contextMaxAgeSeconds ||
          3600,
        logLevel:
          (process.env.LOG_LEVEL as AppConfig["logLevel"]) ||
          configFromFile.logLevel ||
          "info",

        // File Paths from config file (or env vars)
        personaPromptFile:
          process.env.PERSONA_PROMPT_FILE_PATH ||
          configFromFile.personaPromptFile,
        // serverDataPath is loaded directly from env var in constructor
        serverDataPath: this.serverDataPath, // Include the path loaded from env/default

        // 新增字段：直接从YAML配置文件复制
        language: configFromFile.language,
        summary: configFromFile.summary,
        channelManagement: configFromFile.channelManagement,
      };

      // --- Validation ---
      // Validate fields loaded from config.yaml / corresponding env vars
      const requiredFieldsFromConfig: (keyof Omit<
        AppConfig,
        "serverDataPath"
      >)[] = [
        "discordToken",
        "primaryLlmApiKey",
        "primaryLlmBaseUrl",
        "primaryLlmModel",
        "secondaryLlmApiKey",
        "secondaryLlmBaseUrl",
        "secondaryLlmModel",
        "personaPromptFile",
        // serverDataPath is validated separately as it comes directly from env
      ];
      // Validate serverDataPath separately (must come from env or default)
      if (!finalConfig.serverDataPath) {
        throw new Error(
          `Missing required environment variable or default path: SERVER_DATA_PATH`,
        );
      }

      const missingFields = requiredFieldsFromConfig.filter(
        (field) => !finalConfig[field],
      );

      if (missingFields.length > 0) {
        throw new Error(
          `Missing required configuration fields: ${missingFields.join(", ")}. Check environment variables or ${filePath}`,
        );
      }

      loggerService.logger.info(
        "Main config loaded and validated successfully.",
      );
      // Cast to AppConfig after validation ensures all required fields are present
      return finalConfig as AppConfig;
    } catch (error: any) {
      loggerService.logger.error(
        `Error loading main config file (${filePath}): ${error.message}`,
      );
      return null;
    }
  }

  private loadPersonaPrompts(filePath: string): PersonaPrompts | null {
    try {
      loggerService.logger.info(
        `Attempting to load persona prompts from: ${filePath}`,
      );
      if (!fs.existsSync(filePath)) {
        loggerService.logger.error(
          `Persona prompts file not found at: ${filePath}`,
        );
        return null;
      }
      const fileContents = fs.readFileSync(filePath, "utf8");
      const prompts = yaml.load(fileContents) as PersonaPrompts;
      loggerService.logger.info(`Persona prompts loaded: ${prompts}`);
      return prompts;
    } catch (error: any) {
      loggerService.logger.error(
        `Error loading persona prompts file (${filePath}): ${error.message}`,
      );
      return null;
    }
  }

  private watchFile(filePath: string, reloadFn: () => void): void {
    try {
      if (!fs.existsSync(filePath)) {
        loggerService.logger.warn(`Cannot watch file (not found): ${filePath}`);
        return;
      }
      loggerService.logger.info(`Watching file for changes: ${filePath}`);
      const watcher = fs.watch(filePath, (eventType: fs.WatchEventType) => {
        // Explicitly type eventType
        if (eventType === "change") {
          loggerService.logger.info(
            `Detected change in ${filePath}. Reloading...`,
          );
          reloadFn(); // Call the bound instance method
        }
      });
      this.fileWatchers.push(watcher); // Store watcher reference
    } catch (error: any) {
      loggerService.logger.error(
        `Error setting up watcher for ${filePath}: ${error.message}`,
      );
    }
  }

  private reloadMainConfig(): void {
    const oldConfig = this.currentConfig;
    const newConfig = this.loadMainConfig(this.mainConfigPath);
    if (newConfig) {
      this.currentConfig = newConfig;
      if (oldConfig?.logLevel !== newConfig.logLevel) {
        loggerService.updateLogLevel(newConfig.logLevel);
      }
      // Check if dependent file paths changed and reload/rewatch if necessary
      let rewatchNeeded = false;
      if (oldConfig?.personaPromptFile !== newConfig.personaPromptFile) {
        loggerService.logger.info(
          "Persona prompt file path changed. Reloading prompts.",
        );
        this.currentPersonaPrompts = this.loadPersonaPrompts(
          newConfig.personaPromptFile,
        );
        rewatchNeeded = true;
      }
      // If paths changed, reset watchers for all files
      if (rewatchNeeded) {
        loggerService.logger.info(
          "Configuration file paths changed, resetting watchers.",
        );
        this.setupWatchers();
      }
    } else {
      loggerService.logger.error(
        "Failed to reload main config. Keeping previous version.",
      );
    }
  }

  private reloadPersonaPrompts(): void {
    if (this.currentConfig?.personaPromptFile) {
      const newPrompts = this.loadPersonaPrompts(
        this.currentConfig.personaPromptFile,
      );
      if (newPrompts) {
        this.currentPersonaPrompts = newPrompts;
        loggerService.logger.info("Persona prompts reloaded successfully.");
      } else {
        loggerService.logger.error(
          "Failed to reload persona prompts. Keeping previous version.",
        );
      }
    }
  }

  private ensureDataStore(): void {
    if (this.dataStoreInitialized) {
      return;
    }
    if (!this.serverDataPath) {
      loggerService.logger.error(
        "SERVER_DATA_PATH not configured. SQLite datastore cannot be initialized.",
      );
      return;
    }
    initializeDataStore(this.serverDataPath);
    this.dataStoreInitialized = true;
  }

  private normalizeServerConfigValues(config: ServerConfig): ServerConfig {
    const normalized = config;

    if (!normalized.summarySettings) {
      normalized.summarySettings = {
        enabled: false,
        maxMessagesPerSummary: 50,
        cooldownSeconds: 0,
        allowedRoles: [],
        bannedChannels: [],
      };
    } else {
      normalized.summarySettings.enabled = Boolean(
        normalized.summarySettings.enabled,
      );
      normalized.summarySettings.maxMessagesPerSummary = Math.max(
        1,
        Math.min(
          200,
          Math.round(normalized.summarySettings.maxMessagesPerSummary ?? 50),
        ),
      );
      normalized.summarySettings.cooldownSeconds = Math.max(
        0,
        Math.round(normalized.summarySettings.cooldownSeconds ?? 0),
      );
      normalized.summarySettings.allowedRoles = Array.isArray(
        normalized.summarySettings.allowedRoles,
      )
        ? normalized.summarySettings.allowedRoles
        : [];
      normalized.summarySettings.bannedChannels = Array.isArray(
        normalized.summarySettings.bannedChannels,
      )
        ? normalized.summarySettings.bannedChannels
        : [];
    }

    if (!normalized.channelConfig) {
      normalized.channelConfig = {
        allowedChannels: [],
        mode: "whitelist",
        autoManage: false,
      };
    } else {
      normalized.channelConfig.allowedChannels = Array.isArray(
        normalized.channelConfig.allowedChannels,
      )
        ? normalized.channelConfig.allowedChannels
        : [];
      normalized.channelConfig.mode =
        normalized.channelConfig.mode === "blacklist"
          ? "blacklist"
          : "whitelist";
      normalized.channelConfig.autoManage = Boolean(
        normalized.channelConfig.autoManage,
      );
    }

    if (
      !Array.isArray(normalized.allowedChannels) ||
      normalized.allowedChannels.length === 0
    ) {
      normalized.allowedChannels = null;
    }

    if (normalized.maxContextMessages === undefined) {
      delete normalized.maxContextMessages;
    } else {
      normalized.maxContextMessages = Math.min(
        50,
        Math.max(1, Math.round(normalized.maxContextMessages)),
      );
    }

    normalized.completionDelaySeconds = Math.min(
      120,
      Math.max(3, Math.round(normalized.completionDelaySeconds ?? 3)),
    );

    return normalized;
  }
}

const configService = ConfigService.getInstance();
export default configService;
export { ConfigService };
