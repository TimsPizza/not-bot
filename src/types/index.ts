// src/types/index.ts

import { Message } from "discord.js";

/**
 * @description Represents a simplified Discord message object relevant to the bot.
 * We don't need the full discord.js Message object everywhere.
 */
export interface SimpleMessage {
  id: string;
  channelId: string;
  guildId: string | null; // Guild ID might be null for DMs
  authorId: string;
  authorUsername: string;
  content: string;
  timestamp: number; // Unix timestamp
  mentionedUsers: string[]; // Array of mentioned user IDs
  mentionedRoles: string[]; // Array of mentioned role IDs
  mentionsEveryone: boolean;
  isBot: boolean; // Was the author a bot?
  reference?: {
    // For replies
    messageId: string | null;
    channelId: string | null;
    guildId: string | null;
  };
  respondedTo?: boolean; // Optional flag to mark if the bot has responded to this message
  hasBeenRepliedTo: boolean; // To track if the bot has already replied to this message
  // 新增：支持总结功能的字段
  hasAttachments?: boolean;
  hasEmbeds?: boolean;
}

/**
 * @description The result of scoring a single message.
 */
export interface ScoringResult {
  messageId: string;
  score: number;
  reasons: string[]; // Explanations for the score (e.g., "mentioned bot", "long message")
}

/**
 * @description The decision levels after scoring.
 */
export enum ScoreDecision {
  Respond = "RESPOND",
  Discard = "DISCARD",
  Evaluate = "EVALUATE",
}

/**
 * @description The output format for the lightweight LLM evaluation module.
 * Includes a score indicating the confidence/appropriateness of responding.
 */
export interface LLMEvaluationResult {
  should_respond: boolean; // Kept for backward compatibility or simple cases, but response_score is preferred
  response_score: number; // Score from 0.0 to 1.0 indicating how strongly the LLM suggests responding
  target_message_id: string | null; // ID of the message selected for response, if any
  reason: string; // Explanation from the LLM
}

/**
 * @description Represents the context stored for a specific channel or user.
 * For simplicity, starting with channel-based context. User-specific might be added later.
 */
export interface ChannelContext {
  serverId: string; // Added server ID for path construction
  channelId: string;
  messages: SimpleMessage[]; // Recent messages in the channel context
  lastUpdatedAt: number; // Unix timestamp
}

export interface StructuredResponseSegment {
  sequence: number;
  delayMs: number;
  content: string;
}

/**
 * @description Structure for scoring rules loaded from JSON.
 * Example: { "mentionBot": { "weight": 50, "description": "User mentioned the bot" } }
 */
export interface ScoringRule {
  weight: number;
  description: string;
  // Optional: Add more complex conditions later if needed
  // condition?: (message: SimpleMessage) => boolean;
}

export type ScoringRules = Record<string, ScoringRule>;

/**
 * @description Structure for the main configuration (config.yaml). Values are typically loaded from environment variables first.
 */
export interface AppConfig {
  discordToken: string;

  // Primary LLM Configuration (for generating responses)
  primaryLlmApiKey: string;
  primaryLlmBaseUrl: string;
  primaryLlmModel: string;

  // Secondary LLM Configuration (for evaluation)
  secondaryLlmApiKey: string;
  secondaryLlmBaseUrl: string;
  secondaryLlmModel: string;

  // Bot Behavior Configuration
  bufferSize: number; // Max messages in buffer before flush
  bufferTimeWindowMs: number; // Max time before flush (milliseconds)
  scoreThresholdRespond: number;
  scoreThresholdDiscard: number;
  contextMaxMessages: number; // Max messages to keep in context
  contextMaxAgeSeconds: number; // Max age of context messages (seconds)
  logLevel: "info" | "warn" | "error" | "debug" | "trace";
  personaPromptFile: string; // Path to BASE persona prompt template file (e.g., prompts.yaml)
  scoringRulesFile: string; // Path to BASE scoring rules JSON file
  // Paths below are now expected to be provided via environment variables
  serverDataPath: string; // Base path for all server-specific data (e.g., data/)
  // presetPersonasPath: string; // Path to the directory containing preset persona JSON files (e.g., personas/)
  
  // 新增：语言配置
  language?: {
    defaultPrimary: SupportedLanguage;
    defaultFallback: SupportedLanguage;
    autoDetectEnabled: boolean;
    supportedLanguages: Array<{
      code: string;
      name: string;
      flag: string;
    }>;
  };
  
  // 新增：总结功能配置
  summary?: {
    enabled: boolean;
    minMessages: number;
    maxMessages: number;
    defaultCount: number;
    presetCounts: number[];
    cooldownSeconds: number;
    maxConcurrentSummaries: number;
    timeoutSeconds: number;
    defaultServerSettings: {
      enabled: boolean;
      maxMessagesPerSummary: number;
      cooldownSeconds: number;
      allowedRoles: string[];
      bannedChannels: string[];
    };
  };
  
  // 新增：频道管理配置
  channelManagement?: {
    defaultMode: 'whitelist' | 'blacklist';
    autoManageNewChannels: boolean;
    maxChannelsPerPage: number;
    sortBy: 'position' | 'name' | 'type';
  };
}

/**
 * @description Structure for persona prompts (prompts.yaml or similar).
 * These will likely become templates.
 */
export interface PersonaPrompts {
  systemPrompt: string; // Base system prompt template defining the persona
  evaluationPrompt: string; // Prompt template for the LLMEvaluator
  language_instructions?: {
    auto_detect?: string;
    specific_language?: string;
    language_styles?: Record<string, string>;
  };
  summary_prompts?: {
    basic_summary?: string;
    direction_instructions?: Record<string, string>;
    summary_styles?: Record<string, string>;
    error_messages?: Record<string, string>;
  };
  language_detection?: {
    detect_language_prompt?: string;
  };
  // Add more specific prompts as needed (e.g., for specific commands or situations)
}

/**
 * @description Defines the structure for a specific server's configuration override.
 * @description Defines the type of persona reference.
 */
export enum PersonaType {
  Preset = "preset", // References a persona in the global preset directory
  Custom = "custom", // References a persona defined within the server's data directory
}

/**
 * @description Defines how a persona is referenced in the server config.
 */
export interface PersonaRef {
  type: PersonaType;
  id: string; // ID of the preset or custom persona file (without .json extension)
}

/**
 * @description Defines the structure for a specific server's configuration.
 * Stored in <serverDataPath>/<serverId>/config.json
 */
export interface ServerConfig {
  serverId: string;
  responsiveness: number; // Default: 1.0
  allowedChannels: string[] | null; // Default: null (all allowed)
  personaMappings: {
    [channelIdOrDefault: string]: PersonaRef; // Key is channel ID or 'default' for server-wide setting
    // Value references a preset or custom persona
  };
  maxContextMessages?: number; // Optional override for global setting
  maxDailyResponses?: number; // Optional override for global setting (implementation TBD)
  completionDelaySeconds?: number; // Delay before firing completion request
  // Add other server-specific settings here
  
  // 新增：语言配置
  languageConfig?: LanguageConfig;
  
  // 新增：总结功能配置
  summarySettings?: {
    enabled: boolean;
    maxMessagesPerSummary: number;
    cooldownSeconds: number;
    allowedRoles?: string[];  // 可以使用总结功能的角色ID
    bannedChannels?: string[]; // 禁止总结的频道ID
  };
  
  // 增强：频道管理（支持多选）
  channelConfig?: {
    allowedChannels: string[];  // 允许的频道ID列表
    mode: 'whitelist' | 'blacklist';  // 白名单或黑名单模式
    autoManage: boolean;  // 是否自动管理新频道
  };
}

/**
 * @description Defines the structure for a persona definition (used for both presets and custom).
 * Preset: Stored in <presetPersonasPath>/<id>.json
 * Custom: Stored in <serverDataPath>/<serverId>/personas/<id>.json
 */
export interface PersonaDefinition {
  id: string; // Unique identifier (filename without extension)
  name: string; // Display name
  description: string; // Brief description
  details: string; // The core persona definition text to be injected into prompt templates
}

// Renamed PersonaPreset to PersonaDefinition for consistency
export type PersonaPreset = PersonaDefinition;

// 新增：语言配置系统
export enum SupportedLanguage {
  Auto = "auto",        // 自动检测
  Chinese = "zh",       // 中文
  English = "en",       // 英文
  Japanese = "ja",      // 日文
  Korean = "ko",        // 韩文
  Spanish = "es",       // 西班牙文
  French = "fr",        // 法文
  German = "de",        // 德文
  Russian = "ru",       // 俄文
  Portuguese = "pt",    // 葡萄牙文
}

export interface LanguageConfig {
  primary: SupportedLanguage;
  fallback: SupportedLanguage;
  autoDetect: boolean;  // 是否启用自动检测
}

// 总结功能相关类型
export interface SummaryConfig {
  messageId: string;
  count: number;        // 3-50
  direction: 'forward' | 'backward' | 'around';
  sendMode: 'public' | 'private';
  channelId: string;
}

export interface SummaryRequest {
  targetMessage: SimpleMessage;
  config: SummaryConfig;
  requestUser: {
    id: string;
    username: string;
    displayName: string;
  };
  timestamp: Date;
}

export interface SummaryResult {
  summary: string;
  messageCount: number;
  direction: string;
  messageRange: {
    startMessage: {
      id: string;
      url: string;
      timestamp: Date;
    };
    endMessage: {
      id: string;
      url: string;
      timestamp: Date;
    };
  };
  requestId: string;
}

// 新增：频道选择相关类型
export interface ChannelSelectOption {
  channelId: string;
  channelName: string;
  channelType: string;
  enabled: boolean;
  position: number;
}

export interface ChannelManagementState {
  serverId: string;
  channels: ChannelSelectOption[];
  mode: 'whitelist' | 'blacklist';
  pendingChanges: boolean;
}

// 新增：交互组件相关类型
export interface InteractionContext {
  type: 'slash_command' | 'context_menu' | 'modal_submit' | 'button_click' | 'select_menu';
  userId: string;
  channelId: string;
  guildId?: string;
  timestamp: Date;
}

export interface ModalConfig {
  customId: string;
  title: string;
  components: any[];  // Discord.js Modal组件
}

// 新增：总结相关的消息处理类型
export interface MessageBatch {
  messages: SimpleMessage[];
  direction: 'forward' | 'backward' | 'around';
  anchorMessage: SimpleMessage;
  totalCount: number;
}
