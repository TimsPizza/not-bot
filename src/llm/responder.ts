// src/llm/responder.ts
import loggerService from "@/logger";
import configService from "@/config";
import contextManagerService from "@/context";
import { SimpleMessage, PersonaPrompts, AppConfig } from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { callChatCompletionApi } from "./openai_client";

/**
 * @description Convert SimpleMessage array to OpenAI chat completion format
 * Each user message becomes a 'user' role message with username in content
 * Bot's own messages become 'assistant' role messages
 */
function formatMessagesForChat(
  messages: SimpleMessage[],
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [
    // Start with the system prompt that defines the bot's personality
    { role: "system", content: systemPrompt }
  ];

  // Add each message as either a user or assistant message
  messages.forEach((msg) => {
    if (msg.isBot) {
      // Bot's own messages become assistant messages
      result.push({
        role: "assistant",
        content: msg.content
      });
    } else {
      // Other users' messages become user messages with their names
      result.push({
        role: "user",
        content: `${msg.authorUsername}：${msg.content}`
      });
    }
  });

  return result;
}

class ResponderService {
  private static instance: ResponderService;

  private config: AppConfig | null = null;
  private prompts: PersonaPrompts | null = null;

  private constructor() {
    this.loadConfigAndPrompts();
    loggerService.logger.info("ResponderService initialized.");
  }

  /**
   * @description Gets the singleton instance of the ResponderService.
   * @returns {ResponderService} The singleton instance.
   */
  public static getInstance(): ResponderService {
    if (!ResponderService.instance) {
      ResponderService.instance = new ResponderService();
    }
    return ResponderService.instance;
  }

  private loadConfigAndPrompts(): void {
    try {
      this.config = configService.getConfig();
      this.prompts = configService.getPersonaPrompts();
      if (!this.config || !this.prompts) {
        loggerService.logger.error(
          "ResponderService: Config or Prompts not loaded.",
        );
      }
    } catch (error) {
      loggerService.logger.error(
        "Failed to load config/prompts in ResponderService:",
        error,
      );
    }
  }

  /**
   * @description Generates a response using the primary LLM based on channel context.
   * @param channelId The ID of the channel to generate a response for.
   * @param targetMessage Optional: The specific message being responded to (if determined by evaluator).
   * @returns A promise resolving to the generated response string or null.
   */
  public async generateResponse(
    channelId: string,
    targetMessage?: SimpleMessage,
  ): Promise<string | null> {
    // Validate required configuration for primary LLM
    if (
      !this.config ||
      !this.prompts ||
      !this.prompts.systemPrompt ||
      !this.config.primaryLlmApiKey ||
      !this.config.primaryLlmBaseUrl ||
      !this.config.primaryLlmModel
    ) {
      loggerService.logger.error(
        "Primary LLM configuration is incomplete. Cannot generate response.",
      );
      return null;
    }
    const missingConfigs = [];
    if (!this.config) missingConfigs.push('config');
    if (!this.prompts) missingConfigs.push('prompts');
    if (!this.prompts?.evaluationPrompt) missingConfigs.push('evaluationPrompt');
    if (!this.config?.primaryLlmApiKey) missingConfigs.push('secondaryLlmApiKey');
    if (!this.config?.primaryLlmBaseUrl) missingConfigs.push('secondaryLlmBaseUrl');
    if (!this.config?.primaryLlmModel) missingConfigs.push('secondaryLlmModel');

    if (missingConfigs.length > 0) {
      loggerService.logger.error(
      `Secondary LLM configuration is incomplete. Missing: ${missingConfigs.join(', ')}`,
      );
      return null;
    }

    // Get context for the channel
    const context = contextManagerService.getContext(channelId);
    const contextMessages = context?.messages || [];

    if (contextMessages.length === 0) {
      loggerService.logger.warn(
        `No context found for channel ${channelId}. Cannot generate response.`,
      );
      return null; // Cannot respond without context
    }

    try {
      // Convert context messages to chat format
      const chatMessages = formatMessagesForChat(
        contextMessages,
        this.prompts.systemPrompt
      );

      // Add specific instruction for target message if provided
      if (targetMessage) {
        chatMessages.push({
          role: "system",
          content: `请特别注意回应用户 ${targetMessage.authorUsername} 的消息：${targetMessage.content}`
        });
      }

      // Call the API using the main client (for response generation)
      const responseText = await callChatCompletionApi(
        'main',
        this.config.primaryLlmModel,
        chatMessages,
        0.7, // temperature - higher for more creative responses
        150, // max_tokens - adjust based on expected response length
      );

      if (responseText) {
        // Basic response filtering
        const cleanedText = responseText.trim();
        if (cleanedText.toLowerCase().includes("as an ai language model")) {
          loggerService.logger.warn(
            "LLM response contained boilerplate AI disclaimer. Discarding.",
          );
          return null;
        }
        if (cleanedText.length === 0) {
          loggerService.logger.warn("LLM generated an empty response.");
          return null;
        }

        loggerService.logger.info(
          `Generated response: "${cleanedText}"`,
        );
        return cleanedText;
      }

      return null;

    } catch (error) {
      loggerService.logger.error(
        "Error generating response:",
        error,
      );
      return null;
    }
  }
}

// Export the singleton instance directly
const responderService = ResponderService.getInstance();
export default responderService;
export { ResponderService }; // Export the class type if needed elsewhere
