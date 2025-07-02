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
    { role: "system", content: systemPrompt },
  ];

  // Add each message as either a user or assistant message
  messages.forEach((msg) => {
    if (msg.isBot) {
      // Bot's own messages become assistant messages
      result.push({
        role: "assistant",
        content: msg.content,
      });
    } else {
      // Other users' messages become user messages with their names
      result.push({
        role: "user",
        content: `${msg.authorUsername}：${msg.content}`,
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
    languageConfig?: { primary: string; fallback: string; autoDetect: boolean }, // Added
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
      if (!this.config) missingConfigs.push("AppConfig");
      if (!systemPromptTemplate) missingConfigs.push("systemPromptTemplate");
      if (!personaDetails) missingConfigs.push("personaDetails");
      if (!this.config?.primaryLlmApiKey)
        missingConfigs.push("primaryLlmApiKey");
      if (!this.config?.primaryLlmBaseUrl)
        missingConfigs.push("primaryLlmBaseUrl");
      if (!this.config?.primaryLlmModel) missingConfigs.push("primaryLlmModel");
      if (missingConfigs.length > 0) {
        loggerService.logger.error(
          `Secondary LLM configuration is incomplete. Missing: ${missingConfigs.join(", ")}`,
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
      // Generate language instruction based on configuration and prompt templates
      let languageInstruction = "";
      if (languageConfig) {
        const languageNames: Record<string, string> = {
          zh: "中文",
          en: "English",
          ja: "日本語",
          ko: "한국어",
          es: "Español",
          fr: "Français",
          de: "Deutsch",
          ru: "Русский",
          pt: "Português",
        };

        // Get language instruction templates from prompts
        const prompts = configService.getPersonaPrompts();

        if (languageConfig.primary === "auto" && languageConfig.autoDetect) {
          // Use auto-detect template
          languageInstruction =
            prompts?.language_instructions?.auto_detect ||
            "*EXTREMELY IMPORTANT* Automatically detect the language used in the chat context and respond in the corresponding language.";
        } else if (languageConfig.primary !== "auto") {
          // Use specific language template
          const languageName =
            languageNames[languageConfig.primary] || languageConfig.primary;
          const fallbackName =
            languageNames[languageConfig.fallback] || languageConfig.fallback;

          languageInstruction = (
            prompts?.language_instructions?.specific_language ||
            "*EXTREMELY IMPORTANT* Please respond primarily in {{LANGUAGE_NAME}}. Even if the context contains messages in other languages, stick to using the specified language. If you cannot use the primary language, use {{FALLBACK_NAME}} as the fallback language."
          )
            .replace(/\{\{LANGUAGE_NAME\}\}/g, languageName)
            .replace(/\{\{FALLBACK_NAME\}\}/g, fallbackName);
        }
      }

      // If no language config or instruction, use default auto-detect
      if (!languageInstruction) {
        languageInstruction =
          "*EXTREMELY IMPORTANT* Automatically detect the language used in the chat context and respond in the corresponding language.";
      }

      // Inject persona details and language instructions into the system prompt template
      let finalSystemPrompt = systemPromptTemplate
        .replace(/\{\{PERSONA_DETAILS\}\}/g, personaDetails)
        .replace(/\{\{LANGUAGE_INSTRUCTION\}\}/g, languageInstruction);

      if (
        !finalSystemPrompt.includes(personaDetails) &&
        systemPromptTemplate.includes("{{PERSONA_DETAILS}}")
      ) {
        loggerService.logger.warn(
          "Persona details placeholder '{{PERSONA_DETAILS}}' found in system prompt template, but replacement might have failed.",
        );
      }

      // Convert context messages to chat format using the final prompt
      const chatMessages = formatMessagesForChat(
        contextMessages,
        finalSystemPrompt, // Use the injected prompt
      );

      // Add specific instruction for target message if provided
      if (targetMessage) {
        chatMessages.push({
          role: "system",
          content: `请特别注意回应用户 ${targetMessage.authorUsername} 的消息：${targetMessage.content}`,
        });
      }

      // Call the API using the main client (for response generation)
      // Use non-null assertion (!) as config is validated at the start of the method
      const responseText = await callChatCompletionApi(
        "main",
        this.config!.primaryLlmModel,
        chatMessages,
        1, // temperature - higher for more creative responses
        300, // max_tokens - adjust based on expected response length
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

        loggerService.logger.info(`Generated response: "${cleanedText}"`);
        return cleanedText;
      }

      return null;
    } catch (error) {
      loggerService.logger.error("Error generating response:", error);
      return null;
    }
  }
}

// Export the singleton instance directly
const responderService = ResponderService.getInstance();
export default responderService;
export { ResponderService }; // Export the class type if needed elsewhere
