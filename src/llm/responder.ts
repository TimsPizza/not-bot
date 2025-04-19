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
  // Remove prompts property

  private constructor() {
    // Only load AppConfig
    this.config = configService.getConfig();
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

  // Removed loadConfigAndPrompts

  /**
   * @description Generates a response using the primary LLM based on channel context and persona.
   * @param channelId The ID of the channel to generate a response for.
   * @param systemPromptTemplate The base template for the system prompt.
   * @param personaDetails The specific details/instructions for the current persona.
   * @param targetMessage Optional: The specific message being responded to (if determined by evaluator).
   * @returns A promise resolving to the generated response string or null.
   */
  public async generateResponse(
    channelId: string,
    systemPromptTemplate: string, // Added
    personaDetails: string, // Added
    targetMessage?: SimpleMessage,
  ): Promise<string | null> {
    // Validate required configuration for primary LLM
    if (
      !this.config ||
      !systemPromptTemplate || // Check passed template
      !personaDetails || // Check passed details
      !this.config.primaryLlmApiKey ||
      !this.config.primaryLlmBaseUrl ||
      !this.config.primaryLlmModel
    ) {
      const missingConfigs = [];
      if (!this.config) missingConfigs.push('AppConfig');
      if (!systemPromptTemplate) missingConfigs.push('systemPromptTemplate');
      if (!personaDetails) missingConfigs.push('personaDetails');
      if (!this.config?.primaryLlmApiKey) missingConfigs.push('primaryLlmApiKey');
      if (!this.config?.primaryLlmBaseUrl) missingConfigs.push('primaryLlmBaseUrl');
      if (!this.config?.primaryLlmModel) missingConfigs.push('primaryLlmModel');
      if (missingConfigs.length > 0) {
        loggerService.logger.error(
        `Secondary LLM configuration is incomplete. Missing: ${missingConfigs.join(', ')}`,
        );
        return null;
      }
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
      // Inject persona details into the system prompt template
      const finalSystemPrompt = systemPromptTemplate.replace(
          /\{\{PERSONA_DETAILS\}\}/g,
          personaDetails
      );
       if (!finalSystemPrompt.includes(personaDetails) && systemPromptTemplate.includes("{{PERSONA_DETAILS}}")) {
          loggerService.logger.warn("Persona details placeholder '{{PERSONA_DETAILS}}' found in system prompt template, but replacement might have failed.");
      }


      // Convert context messages to chat format using the final prompt
      const chatMessages = formatMessagesForChat(
        contextMessages,
        finalSystemPrompt // Use the injected prompt
      );

      // Add specific instruction for target message if provided
      if (targetMessage) {
        chatMessages.push({
          role: "system",
          content: `请特别注意回应用户 ${targetMessage.authorUsername} 的消息：${targetMessage.content}`
        });
      }

      // Call the API using the main client (for response generation)
      // Use non-null assertion (!) as config is validated at the start of the method
      const responseText = await callChatCompletionApi(
        'main',
        this.config!.primaryLlmModel,
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
