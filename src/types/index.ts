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
 */
export interface LLMEvaluationResult {
  should_respond: boolean;
  target_message_id: string | null; // ID of the message selected for response, if any
  reason: string; // Explanation from the LLM
}

/**
 * @description Represents the context stored for a specific channel or user.
 * For simplicity, starting with channel-based context. User-specific might be added later.
 */
export interface ChannelContext {
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
  personaPromptFile: string; // Path to persona prompt file (loaded separately)
  scoringRulesFile: string; // Absolute path to scoring rules JSON file
  contextStoragePath: string; // Absolute path to store context JSON files
}

/**
 * @description Structure for persona prompts (prompts.yaml or similar).
 */
export interface PersonaPrompts {
  systemPrompt: string; // Base system prompt defining the persona
  evaluationPrompt: string; // Prompt for the LLMEvaluator
  // Add more specific prompts as needed (e.g., for specific commands or situations)
}
