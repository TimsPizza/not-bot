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
}

/**
 * @description Structure for persona prompts (prompts.yaml or similar).
 * These will likely become templates.
 */
export interface PersonaPrompts {
  systemPrompt: string; // Base system prompt template defining the persona
  evaluationPrompt: string; // Prompt template for the LLMEvaluator
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
  // Add other server-specific settings here
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
