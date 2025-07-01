// src/config/index.ts
import fs from "fs-extra"; // Use fs-extra for ensureDirSync etc.
import path from "path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import loggerService from "@/logger"; // Import logger service instance
import {
  AppConfig,
  ScoringRules,
  PersonaPrompts,
  ServerConfig,
  PersonaDefinition,
  PersonaPreset,
  PersonaRef,
  PersonaType,
} from "@/types"; // Updated imports

class ConfigService {
  private static instance: ConfigService;

  private currentConfig: AppConfig | null = null;
  private currentScoringRules: ScoringRules | null = null;
  private currentPersonaPrompts: PersonaPrompts | null = null; // Base prompt templates
  private serverConfigs: Map<string, ServerConfig> = new Map(); // Cache for server configs <serverId, ServerConfig>
  private presetPersonas: Map<string, PersonaDefinition> = new Map(); // Cache for preset personas <presetId, PersonaDefinition>

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
   * @description Gets the current scoring rules. Returns null if not loaded.
   * @returns {ScoringRules | null} The current scoring rules object or null.
   */
  public getScoringRules(): ScoringRules | null {
    return this.currentScoringRules;
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
    return this.presetPersonas.get(presetId);
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
    if (personaRef.type === PersonaType.Preset) {
      const preset = this.getPresetPersona(personaRef.id);
      if (!preset) {
        loggerService.logger.error(
          `Preset persona '${personaRef.id}' referenced by server ${serverId} not found. Falling back to default preset.`,
        );
        return this.getPresetPersona("default"); // Fallback
      }
      return preset;
    } else if (personaRef.type === PersonaType.Custom) {
      // Load custom persona from server's data directory
      const customPersonaPath = path.join(
        this.serverDataPath,
        serverId,
        "personas",
        `${personaRef.id}.json`,
      );
      try {
        if (fs.existsSync(customPersonaPath)) {
          const fileContent = fs.readFileSync(customPersonaPath, "utf-8");
          const customPersona = JSON.parse(fileContent) as PersonaDefinition;
          // Basic validation
          if (
            customPersona.id &&
            customPersona.name &&
            customPersona.description &&
            customPersona.details
          ) {
            // Ensure ID matches ref ID
            if (customPersona.id !== personaRef.id) {
              loggerService.logger.warn(
                `Custom persona ID in file ${customPersonaPath} ('${customPersona.id}') differs from reference ID ('${personaRef.id}'). Using reference ID.`,
              );
              customPersona.id = personaRef.id;
            }
            loggerService.logger.debug(
              `Loaded custom persona '${customPersona.id}' for server ${serverId}`,
            );
            return customPersona;
          } else {
            loggerService.logger.error(
              `Invalid structure in custom persona file: ${customPersonaPath}`,
            );
          }
        } else {
          loggerService.logger.error(
            `Custom persona file not found: ${customPersonaPath}`,
          );
        }
      } catch (error: any) {
        loggerService.logger.error(
          `Error loading custom persona file ${customPersonaPath}: ${error.message}`,
        );
      }
      // Fallback if custom load fails
      loggerService.logger.warn(
        `Failed to load custom persona '${personaRef.id}' for server ${serverId}. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    } else {
      loggerService.logger.error(
        `Unknown persona type '${personaRef.type}' for persona ID '${personaRef.id}' in server ${serverId}. Falling back to default preset.`,
      );
      return this.getPresetPersona("default");
    }
  }

  /**
   * @description Gets the configuration for a specific server, loading if necessary.
   * Falls back to defaults if the server has no specific config file or it's invalid.
   * @param serverId The Discord Guild ID.
   * @returns {ServerConfig} The server's configuration.
   */
  public getServerConfig(serverId: string): ServerConfig {
    // 1. Check cache
    if (this.serverConfigs.has(serverId)) {
      return this.serverConfigs.get(serverId)!;
    }

    // 2. Try loading from file using serverDataPath
    const serverSpecificDataPath = path.join(this.serverDataPath, serverId); // Correct variable name
    const configFilePath = path.join(serverSpecificDataPath, "config.json"); // Correct variable name
    let loadedConfig: ServerConfig | null = null;

    if (fs.existsSync(configFilePath)) {
      try {
        const fileContent = fs.readFileSync(configFilePath, "utf-8");
        const parsedConfig = JSON.parse(fileContent) as Partial<ServerConfig>;
        // Basic validation and merging with defaults
        loadedConfig = {
          ...this.getDefaultServerConfig(serverId), // Start with defaults
          ...parsedConfig, // Override with loaded values
          serverId: serverId, // Ensure serverId is correct
          // Ensure personaMappings exists and has a default if missing in loaded file
          personaMappings:
            parsedConfig.personaMappings &&
            Object.keys(parsedConfig.personaMappings).length > 0
              ? parsedConfig.personaMappings
              : this.getDefaultServerConfig(serverId).personaMappings,
        };
        // Add more specific validation if needed (e.g., responsiveness range)
        if (
          typeof loadedConfig.responsiveness !== "number" ||
          loadedConfig.responsiveness < 0
        ) {
          loggerService.logger.warn(
            `Invalid responsiveness value for server ${serverId} in ${configFilePath}. Resetting to default.`,
          );
          loadedConfig.responsiveness =
            this.getDefaultServerConfig(serverId).responsiveness;
        }
        loggerService.logger.debug(
          `Loaded server config for ${serverId} from ${configFilePath}`,
        );
      } catch (error: any) {
        loggerService.logger.error(
          `Error loading or parsing server config file ${configFilePath}: ${error.message}. Using defaults.`,
        );
        loadedConfig = this.getDefaultServerConfig(serverId);
      }
    } else {
      // File doesn't exist or failed to load/parse, use defaults
      loggerService.logger.debug(
        `No valid config file found for server ${serverId} at ${configFilePath}. Using defaults.`,
      );
      loadedConfig = this.getDefaultServerConfig(serverId);
    }

    // 3. Cache and return
    this.serverConfigs.set(serverId, loadedConfig);
    return loadedConfig;
  }

  /**
   * @description Saves a server's configuration to its JSON file.
   * @param serverConfig The ServerConfig object to save.
   * @returns {Promise<boolean>} True if successful, false otherwise.
   */
  public async saveServerConfig(serverConfig: ServerConfig): Promise<boolean> {
    if (!this.serverDataPath) {
      loggerService.logger.error(
        "Cannot save server config: SERVER_DATA_PATH is not configured.",
      );
      return false;
    }
    const serverSpecificDataPath = path.join(
      this.serverDataPath,
      serverConfig.serverId,
    ); // Correct variable name
    const configFilePath = path.join(serverSpecificDataPath, "config.json"); // Correct variable name
    try {
      // Ensure the server-specific directory exists
      await fs.ensureDir(serverSpecificDataPath);

      const configJson = JSON.stringify(serverConfig, null, 2); // Pretty print JSON
      await fs.writeFile(configFilePath, configJson, "utf-8");

      // Update cache
      this.serverConfigs.set(serverConfig.serverId, serverConfig);

      loggerService.logger.info(
        `Successfully saved server config for ${serverConfig.serverId} to ${configFilePath}`,
      );
      return true;
    } catch (error: any) {
      loggerService.logger.error(
        `Error saving server config file ${configFilePath}: ${error.message}`,
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
      // maxContextMessages: undefined,
      // maxDailyResponses: undefined,
    };
  }

  /**
   * @description Loads all valid persona definition files from the preset personas directory.
   */
  private loadPresetPersonas(): void {
    if (!this.presetPersonasPath) {
      loggerService.logger.warn(
        `PRESET_PERSONAS_PATH is not defined. Cannot load preset personas.`,
      );
      this.presetPersonas.clear();
      return;
    }
    if (!fs.existsSync(this.presetPersonasPath)) {
      loggerService.logger.warn(
        `Preset personas directory not found: ${this.presetPersonasPath}. No preset personas loaded.`,
      );
      this.presetPersonas.clear();
      return;
    }

    loggerService.logger.info(
      `Loading preset personas from: ${this.presetPersonasPath}`,
    );
    const loadedPersonas = new Map<string, PersonaDefinition>();
    try {
      const files = fs.readdirSync(this.presetPersonasPath);
      for (const file of files) {
        if (file.endsWith(".json")) {
          // Only load .json files
          const filePath = path.join(this.presetPersonasPath, file);
          const personaId = path.basename(file, ".json"); // Use filename as ID
          try {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const personaData = JSON.parse(
              fileContent,
            ) as Partial<PersonaDefinition>;

            // Basic validation
            if (
              personaData.name &&
              personaData.description &&
              personaData.details
            ) {
              if (loadedPersonas.has(personaId)) {
                loggerService.logger.warn(
                  `Duplicate preset persona ID '${personaId}' found in ${file}. Skipping.`,
                );
                continue;
              }
              // Ensure the ID from the file matches the filename if present, otherwise use filename
              const finalId =
                personaData.id && personaData.id !== personaId
                  ? personaData.id // Prefer ID from file content if it exists and differs
                  : personaId;

              if (personaData.id && personaData.id !== personaId) {
                loggerService.logger.warn(
                  `Persona ID in file ${file} ('${personaData.id}') differs from filename ('${personaId}'). Using ID from file content.`,
                );
              }

              loadedPersonas.set(finalId, {
                id: finalId,
                name: personaData.name,
                description: personaData.description,
                details: personaData.details,
              });
              loggerService.logger.debug(
                `Loaded preset persona: ${finalId} from ${file}`,
              );
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
      }
    } catch (error: any) {
      loggerService.logger.error(
        `Error reading preset personas directory ${this.presetPersonasPath}: ${error.message}`,
      );
    }

    if (loadedPersonas.size === 0) {
      loggerService.logger.warn("No valid preset personas were loaded.");
    } else {
      loggerService.logger.info(
        `Successfully loaded ${loadedPersonas.size} preset personas.`,
      );
    }
    this.presetPersonas = loadedPersonas;

    // Ensure a 'default' persona exists, otherwise log a critical warning
    if (!this.presetPersonas.has("default")) {
      loggerService.logger.error(
        "CRITICAL: Default preset persona ('default.json') not found or failed to load. Bot may not function correctly.",
      );
      // Optionally, create a minimal fallback default persona here?
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

    if (this.currentConfig.scoringRulesFile) {
      this.currentScoringRules = this.loadScoringRules(
        this.currentConfig.scoringRulesFile,
      );
    } else {
      loggerService.logger.error(
        "Scoring rules file path not defined in main config.",
      );
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
    if (this.currentConfig?.scoringRulesFile) {
      this.watchFile(
        this.currentConfig.scoringRulesFile,
        this.reloadScoringRules.bind(this),
      );
    }
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
        scoreThresholdRespond:
          parseInt(process.env.SCORE_THRESHOLD_RESPOND || "", 10) ||
          configFromFile.scoreThresholdRespond ||
          80,
        scoreThresholdDiscard:
          parseInt(process.env.SCORE_THRESHOLD_DISCARD || "", 10) ||
          configFromFile.scoreThresholdDiscard ||
          -10,
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
        scoringRulesFile:
          process.env.SCORING_RULES_FILE_PATH ||
          configFromFile.scoringRulesFile,
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
        "scoringRulesFile",
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

  private loadScoringRules(filePath: string): ScoringRules | null {
    try {
      loggerService.logger.info(
        `Attempting to load scoring rules from: ${filePath}`,
      );
      if (!fs.existsSync(filePath)) {
        loggerService.logger.error(
          `Scoring rules file not found at: ${filePath}`,
        );
        return null;
      }
      const fileContents = fs.readFileSync(filePath, "utf8");
      const rules = JSON.parse(fileContents) as ScoringRules;
      loggerService.logger.info("Scoring rules loaded successfully.");
      return rules;
    } catch (error: any) {
      loggerService.logger.error(
        `Error loading scoring rules file (${filePath}): ${error.message}`,
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
      if (oldConfig?.scoringRulesFile !== newConfig.scoringRulesFile) {
        loggerService.logger.info(
          "Scoring rules file path changed. Reloading rules.",
        );
        this.currentScoringRules = this.loadScoringRules(
          newConfig.scoringRulesFile,
        );
        rewatchNeeded = true;
      }
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

  private reloadScoringRules(): void {
    if (this.currentConfig?.scoringRulesFile) {
      const newRules = this.loadScoringRules(
        this.currentConfig.scoringRulesFile,
      );
      if (newRules) {
        this.currentScoringRules = newRules;
        loggerService.logger.info("Scoring rules reloaded successfully.");
      } else {
        loggerService.logger.error(
          "Failed to reload scoring rules. Keeping previous version.",
        );
      }
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
}

// Export the singleton instance directly
const configService = ConfigService.getInstance();
export default configService; // Export the instance
export { ConfigService }; // Export the class type if needed elsewhere
