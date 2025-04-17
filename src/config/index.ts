// src/config/index.ts
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import loggerService from "@/logger"; // Import logger service instance
import { AppConfig, ScoringRules, PersonaPrompts } from "@/types";

class ConfigService {
  private static instance: ConfigService;

  private currentConfig: AppConfig | null = null;
  private currentScoringRules: ScoringRules | null = null;
  private currentPersonaPrompts: PersonaPrompts | null = null;

  private mainConfigPath: string;
  // Store watchers to potentially close them later if needed, though fs.watch is tricky
  private fileWatchers: fs.FSWatcher[] = [];

  private constructor() {
    dotenv.config(); // Load .env file first

    const DEFAULT_CONFIG_DIR = path.resolve(process.cwd(), "config");
    this.mainConfigPath =
      process.env.CONFIG_FILE_PATH ||
      path.join(DEFAULT_CONFIG_DIR, "config.yaml");

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
    return this.currentPersonaPrompts;
  }

  // --- Private Loading and Reloading Logic ---

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
    loggerService.updateLogLevel(this.currentConfig.logLevel);

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

    this.setupWatchers();
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
        discordToken: process.env.DISCORD_BOT_TOKEN || configFromFile.discordToken,

        // Primary LLM
        primaryLlmApiKey: process.env.OPENAI_PRIMARY_API_KEY || configFromFile.primaryLlmApiKey,
        primaryLlmBaseUrl: process.env.OPENAI_PRIMARY_BASE_URL || configFromFile.primaryLlmBaseUrl || 'https://api.openai.com/v1', // Default OpenAI URL
        primaryLlmModel: process.env.OPENAI_PRIMARY_MODEL || configFromFile.primaryLlmModel,

        // Secondary LLM
        secondaryLlmApiKey: process.env.OPENAI_SECONDARY_API_KEY || configFromFile.secondaryLlmApiKey,
        secondaryLlmBaseUrl: process.env.OPENAI_SECONDARY_BASE_URL || configFromFile.secondaryLlmBaseUrl || 'https://api.openai.com/v1', // Default OpenAI URL
        secondaryLlmModel: process.env.OPENAI_SECONDARY_MODEL || configFromFile.secondaryLlmModel,

        // Bot Behavior (use defaults if not in env or file)
        bufferSize: parseInt(process.env.BUFFER_SIZE || '', 10) || configFromFile.bufferSize || 10,
        bufferTimeWindowMs: parseInt(process.env.BUFFER_TIME_WINDOW_MS || '', 10) || configFromFile.bufferTimeWindowMs || 2000,
        scoreThresholdRespond: parseInt(process.env.SCORE_THRESHOLD_RESPOND || '', 10) || configFromFile.scoreThresholdRespond || 80,
        scoreThresholdDiscard: parseInt(process.env.SCORE_THRESHOLD_DISCARD || '', 10) || configFromFile.scoreThresholdDiscard || -10,
        contextMaxMessages: parseInt(process.env.CONTEXT_MAX_MESSAGES || '', 10) || configFromFile.contextMaxMessages || 20,
        contextMaxAgeSeconds: parseInt(process.env.CONTEXT_MAX_AGE_SECONDS || '', 10) || configFromFile.contextMaxAgeSeconds || 3600,
        logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) || configFromFile.logLevel || 'info',

        // File Paths (prefer env vars, fallback to file, then maybe error or default?)
        // It's generally better to require these paths.
        personaPromptFile: process.env.PERSONA_PROMPT_FILE_PATH || configFromFile.personaPromptFile,
        scoringRulesFile: process.env.SCORING_RULES_FILE_PATH || configFromFile.scoringRulesFile,
        contextStoragePath: process.env.CONTEXT_STORAGE_PATH || configFromFile.contextStoragePath,
      };

      // --- Validation ---
      const requiredFields: (keyof AppConfig)[] = [
        'discordToken',
        'primaryLlmApiKey', 'primaryLlmBaseUrl', 'primaryLlmModel',
        'secondaryLlmApiKey', 'secondaryLlmBaseUrl', 'secondaryLlmModel',
        'personaPromptFile', 'scoringRulesFile', 'contextStoragePath'
      ];

      const missingFields = requiredFields.filter(field => !finalConfig[field]);

      if (missingFields.length > 0) {
        throw new Error(`Missing required configuration fields: ${missingFields.join(', ')}. Check environment variables or ${filePath}`);
      }

      loggerService.logger.info("Main config loaded and validated successfully.");
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
      const watcher = fs.watch(filePath, (eventType) => {
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
