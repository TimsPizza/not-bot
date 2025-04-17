// src/scorer/index.ts
import loggerService from "@/logger";
import configService from "@/config";
import {
  SimpleMessage,
  ScoringResult,
  ScoringRules,
  ScoreDecision,
  AppConfig,
} from "@/types";
// Import ContextManagerService later if needed for context-aware scoring (e.g., repetition check)
import contextManagerService from "@/context";

// Helper function type for individual scoring rules
type ScoringRuleFunction = (
  message: SimpleMessage,
  contextMessages?: SimpleMessage[],
) => { score: number; reason?: string };

class ScorerService {
  private static instance: ScorerService;

  private scoringRules: ScoringRules | null = null;
  private config: AppConfig | null = null;
  private ruleFunctions: Map<string, ScoringRuleFunction> = new Map();

  private constructor() {
    this.loadConfigAndRules();
    this.registerRuleFunctions();
    loggerService.logger.info("ScorerService initialized.");
    // TODO: Listen for config changes to reload rules?
  }

  /**
   * @description Gets the singleton instance of the ScorerService.
   * @returns {ScorerService} The singleton instance.
   */
  public static getInstance(): ScorerService {
    if (!ScorerService.instance) {
      ScorerService.instance = new ScorerService();
    }
    return ScorerService.instance;
  }

  /**
   * @description Loads configuration and scoring rules.
   */
  private loadConfigAndRules(): void {
    try {
      this.config = configService.getConfig();
      this.scoringRules = configService.getScoringRules();
      if (!this.scoringRules) {
        loggerService.logger.error(
          "Scoring rules not found in configuration. Scorer will not function correctly.",
        );
      }
      if (!this.config) {
        loggerService.logger.error(
          "App config not found. Scorer will use defaults or fail.",
        );
      }
    } catch (error) {
      loggerService.logger.error(
        "Failed to load config/rules in ScorerService:",
        error,
      );
    }
  }

  /**
   * @description Registers the functions that implement each scoring rule logic.
   */
  private registerRuleFunctions(): void {
    // --- Register rule implementations ---
    this.ruleFunctions.set("mentionBot", this.checkMentionBot);
    this.ruleFunctions.set("isQuestion", this.checkIsQuestion);
    this.ruleFunctions.set("isReplyToBot", this.checkIsReplyToBot); // Needs refinement
    this.ruleFunctions.set("lengthLong", this.checkLengthLong);
    this.ruleFunctions.set("lengthShort", this.checkLengthShort);
    this.ruleFunctions.set("containsKeywords", this.checkContainsKeyWords); // Needs refinement
    // this.ruleFunctions.set("repeatedContent", this.checkRepeatedContent); // Needs context
    this.ruleFunctions.set("allCaps", this.checkAllCaps);
    this.ruleFunctions.set(
      "excessivePunctuation",
      this.checkExcessivePunctuation,
    );
    this.ruleFunctions.set("codeBlock", this.checkCodeBlock);
    this.ruleFunctions.set("urlLink", this.checkUrlLink);
    this.ruleFunctions.set("botAuthor", this.checkBotAuthor);
    this.ruleFunctions.set("nonTextMessage", this.checkNonTextMessage); // Needs refinement

    loggerService.logger.debug("Registered scoring rule functions.");
  }

  /**
   * @description Scores a batch of messages based on the loaded rules.
   * @param channelId The ID of the channel the messages are from.
   * @param messages An array of SimpleMessage objects to score.
   * @returns An array of ScoringResult objects.
   */
  public scoreMessages(
    channelId: string,
    messages: SimpleMessage[],
  ): ScoringResult[] {
    if (!this.scoringRules || !this.config) {
      loggerService.logger.error(
        "Scoring rules or config not loaded. Cannot score messages.",
      );
      return messages.map((msg) => ({
        messageId: msg.id,
        score: 0,
        reasons: ["Scoring disabled"],
      }));
    }

    const results: ScoringResult[] = [];
    // Get context for repetition check (optional, could be expensive)
    const channelContext = contextManagerService.getContext(channelId);
    const contextMessages = channelContext?.messages || [];

    for (const message of messages) {
      let totalScore = 0;
      const reasons: string[] = [];

      for (const ruleName in this.scoringRules) {
        const rule = this.scoringRules[ruleName];
        // Ensure the rule actually exists before proceeding
        if (!rule) {
          loggerService.logger.warn(
            `Scoring rule definition not found for key: ${ruleName}`,
          );
          continue;
        }
        const ruleFn = this.ruleFunctions.get(ruleName);

        if (ruleFn) {
          try {
            // Pass context only if needed by the rule (e.g., repetition check)
            const contextAwareRules = ["repeatedContent"]; // Example
            const contextArg = contextAwareRules.includes(ruleName)
              ? contextMessages
              : undefined;
            const result = ruleFn.call(this, message, contextArg); // Call rule function
            
            loggerService.logger.debug(
              `Rule '${ruleName}' scored ${result.score ? rule.weight : 0} for message ${message.id}`,
            );

            if (result.score !== 0) {
              // totalScore += result.score * (rule.weight / 100); // Apply weight as a percentage multiplier? Or direct addition? Let's try direct addition first.
              totalScore += rule.weight; // Direct weight addition based on rule match
              if (result.reason) {
                reasons.push(
                  `${result.reason} (${ruleName}: ${rule.weight > 0 ? "+" : ""}${rule.weight})`,
                );
              } else {
                reasons.push(
                  `${ruleName}: ${rule.weight > 0 ? "+" : ""}${rule.weight}`,
                );
              }
            }
          } catch (error) {
            loggerService.logger.warn(
              `Error executing scoring rule function '${ruleName}' for message ${message.id}:`,
              error,
            );
          }
        } else {
          loggerService.logger.warn(
            `No scoring function registered for rule: ${ruleName}`,
          );
        }
      }

      // Clamp score? Ensure it doesn't go infinitely high/low? For now, no clamp.
      loggerService.logger.debug(
        `Message ${message.id} scored: ${totalScore}. Reasons: [${reasons.join(", ")}]`,
      );
      results.push({
        messageId: message.id,
        score: Math.round(totalScore),
        reasons,
      }); // Round score
    }

    return results;
  }

  /**
   * @description Determines the next action for a batch based on aggregated scores.
   * Uses a combination of max score and average score of valid messages.
   * @param results An array of ScoringResult objects for the batch.
   * @returns The ScoreDecision (Respond, Discard, Evaluate) for the entire batch.
   */
  public getDecisionForBatch(results: ScoringResult[]): ScoreDecision {
    const FILTER_THRESHOLD = -1000; // Scores below this are ignored for avg/max calculations

    if (!this.config) {
      loggerService.logger.error(
        "Cannot get decision for batch, config not loaded.",
      );
      return ScoreDecision.Discard; // Default to discard if config is missing
    }
    if (!results || results.length === 0) {
      return ScoreDecision.Discard; // Discard empty batches
    }

    // Filter out results from messages that should be ignored (e.g., bot author)
    const validResults = results.filter((r) => r.score > FILTER_THRESHOLD);
    const validMessageCount = validResults.length;

    if (validMessageCount === 0) {
      loggerService.logger.debug(
        "Batch contains no valid messages after filtering. Discarding.",
      );
      return ScoreDecision.Discard;
    }

    // Calculate metrics from valid messages
    let highestScore = -Infinity;
    let scoreSum = 0;
    validResults.forEach((r) => {
      highestScore = Math.max(highestScore, r.score);
      scoreSum += r.score;
    });
    const averageScore = scoreSum / validMessageCount;

    loggerService.logger.debug(
      `Batch Metrics: validCount=${validMessageCount}, highestScore=${highestScore}, averageScore=${averageScore.toFixed(2)}`,
    );

    // Apply decision logic
    const { scoreThresholdRespond, scoreThresholdDiscard } = this.config;

    // Condition for Direct Response: High peak score AND batch average isn't too low
    if (
      highestScore >= scoreThresholdRespond &&
      averageScore > scoreThresholdDiscard
    ) {
      loggerService.logger.debug(
        `Decision: Respond (High max score ${highestScore} >= ${scoreThresholdRespond} and Avg score ${averageScore.toFixed(2)} > ${scoreThresholdDiscard})`,
      );
      return ScoreDecision.Respond;
    }
    // Condition for Discard: Low average score
    else if (averageScore <= scoreThresholdDiscard) {
      loggerService.logger.debug(
        `Decision: Discard (Avg score ${averageScore.toFixed(2)} <= ${scoreThresholdDiscard})`,
      );
      return ScoreDecision.Discard;
    }
    // Otherwise, Evaluate
    else {
      loggerService.logger.debug(
        `Decision: Evaluate (Max score ${highestScore} < ${scoreThresholdRespond} or Avg score ${averageScore.toFixed(2)} <= ${scoreThresholdDiscard}, but Avg score > ${scoreThresholdDiscard})`,
      );
      return ScoreDecision.Evaluate;
    }
  }

  // --- Individual Rule Implementations ---
  // These functions return { score: number (usually 1 or 0, sometimes -1), reason?: string }
  // The actual weight is applied in scoreMessages based on the config.

  private checkMentionBot(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    // Assuming bot's user ID is available somehow, e.g., from discord.js client instance
    // Placeholder: Need to get the actual bot ID
    const botId =
      process.env.DISCORD_BOT_ID ||
      configService.getConfig()?.discordToken?.split(".")[0]; // Crude way, better pass client user ID
    const mentioned = message.mentionedUsers.includes(
      botId || "INVALID_BOT_ID",
    );
    return {
      score: mentioned ? 1 : 0,
      reason: mentioned ? "Mentioned bot" : undefined,
    };
  }

  private checkIsQuestion(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const questionWords = [
      "?",
      "？",
      "怎么",
      "什么",
      "谁",
      "哪",
      "吗",
      "呢",
      "为何",
      "为什么",
      "how",
      "what",
      "who",
      "where",
      "why",
      "when",
      "is ",
      "are ",
      "do ",
      "does ",
    ];
    const contentLower = message.content.toLowerCase();
    const isQuestion =
      contentLower.endsWith("?") ||
      contentLower.endsWith("？") ||
      contentLower.endsWith("?") ||
      questionWords.some((word) => contentLower.includes(word));
    return {
      score: isQuestion ? 1 : 0,
      reason: isQuestion ? "Is a question" : undefined,
    };
  }

  private checkIsReplyToBot(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const botId =
      process.env.DISCORD_BOT_ID ||
      configService.getConfig()?.discordToken?.split(".")[0];
    // This requires fetching the referenced message, which is async and complex here.
    // Simplification: Check if the message *has* a reference. A better check needs the referenced message author.
    const isReply = !!message.reference?.messageId;
    // TODO: Enhance this check by fetching the referenced message if performance allows.
    return {
      score: isReply ? 1 : 0,
      reason: isReply ? "Is a reply to bot" : undefined,
    };
  }

  private checkLengthLong(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const longLengthThreshold = 20; // Example threshold
    const isLong = message.content.length > longLengthThreshold;
    return {
      score: isLong ? 1 : 0,
      reason: isLong ? `Length > ${longLengthThreshold}` : undefined,
    };
  }

  private checkLengthShort(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const shortLengthThreshold = 5; // Example threshold
    const isShort = message.content.length < shortLengthThreshold;
    return {
      score: isShort ? 1 : 0,
      reason: isShort ? `Length < ${shortLengthThreshold}` : undefined,
    }; // Score 1 means the condition is met, weight is negative
  }

  private checkContainsKeyWords(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const keywords = ["bot", "机器人", "老张"]; // Example keywords from user feedback + original plan
    const contentLower = message.content.toLowerCase();
    const contains = keywords.some((word) => contentLower.includes(word));
    return {
      score: contains ? 1 : 0,
      reason: contains ? "Contains keywords" : undefined,
    };
  }

  private checkRepeatedContent(
    message: SimpleMessage,
    contextMessages?: SimpleMessage[],
  ): { score: number; reason?: string } {
    if (!contextMessages || contextMessages.length === 0) return { score: 0 };
    // Simple check: is the exact content present in the last N messages?
    const lookback = 5; // Check last 5 messages
    const recentMessages = contextMessages.slice(-lookback);
    const isRepeated = recentMessages.some(
      (ctxMsg) =>
        ctxMsg.content === message.content &&
        ctxMsg.authorId === message.authorId,
    );
    return {
      score: isRepeated ? 1 : 0,
      reason: isRepeated ? "Repeated content" : undefined,
    }; // Score 1 means condition met, weight is negative
  }

  private checkAllCaps(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const content = message.content.replace(/[^a-zA-Z]/g, ""); // Remove non-alpha chars
    if (content.length < 5) return { score: 0 }; // Ignore short messages
    const isAllCaps = content === content.toUpperCase();
    return {
      score: isAllCaps ? 1 : 0,
      reason: isAllCaps ? "All caps" : undefined,
    };
  }

  private checkExcessivePunctuation(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const punctuationMatches = message.content.match(/[.,!?;:(){}[\]"']/g); // Basic punctuation
    const emojiMatches = message.content.match(/\p{Emoji}/gu); // Match Unicode emojis
    const punctuationCount =
      (punctuationMatches?.length || 0) + (emojiMatches?.length || 0);
    const threshold = 10; // Example threshold
    const isExcessive =
      punctuationCount > threshold ||
      (message.content.length > 0 &&
        punctuationCount / message.content.length > 0.5); // More than 10 or >50% punctuation/emoji
    return {
      score: isExcessive ? 1 : 0,
      reason: isExcessive ? "Excessive punctuation/emoji" : undefined,
    };
  }

  private checkCodeBlock(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    const hasCodeBlock = /```[\s\S]*?```/.test(message.content);
    return {
      score: hasCodeBlock ? 1 : 0,
      reason: hasCodeBlock ? "Contains code block" : undefined,
    };
  }

  private checkUrlLink(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    // Basic URL check, might need refinement
    const hasUrl = /https?:\/\/[^\s]+/.test(message.content);
    return {
      score: hasUrl ? 1 : 0,
      reason: hasUrl ? "Contains URL" : undefined,
    };
  }

  private checkBotAuthor(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    return {
      score: message.isBot ? 1 : 0,
      reason: message.isBot ? "Author is bot" : undefined,
    };
  }

  private checkNonTextMessage(message: SimpleMessage): {
    score: number;
    reason?: string;
  } {
    // Check if content is empty or only whitespace after potentially removing URLs/mentions etc.
    // A more robust check might involve checking attachments/embeds on the original discord.js message object
    const isEmpty = message.content.trim().length === 0;
    return {
      score: isEmpty ? 1 : 0,
      reason: isEmpty ? "Non-text or empty message" : undefined,
    };
  }
}

// Export the singleton instance directly
const scorerService = ScorerService.getInstance();
export default scorerService;
export { ScorerService }; // Export the class type if needed
