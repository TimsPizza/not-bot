// src/llm/llm_evaluator.ts
import loggerService from "@/logger";
import configService from "@/config";
import { SimpleMessage, LLMEvaluationResult, PersonaPrompts, AppConfig } from "@/types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { callChatCompletionApi } from "./openai_client";

/**
 * @description Convert messages to a format suitable for evaluation.
 * Combines recent context and the current batch for LLM evaluation.
 */
function formatMessagesForEvaluation(
  channelContextMessages: SimpleMessage[],
  batchMessages: SimpleMessage[],
  evaluationPrompt: string,
  contextLookback: number = 10, // How many recent context messages to include
): ChatCompletionMessageParam[] {
  // Start with the evaluation prompt as system message
  const result: ChatCompletionMessageParam[] = [
    { role: "system", content: evaluationPrompt }
  ];

  // Combine recent context and the current batch
  const recentContext = channelContextMessages.slice(-contextLookback);
  const messagesToEvaluate = [...recentContext, ...batchMessages];

  // Add a user message containing the combined messages in a clear format
  // We send the combined list for the LLM to understand the flow.
  const formattedMessages = messagesToEvaluate.map(msg => ({
    id: msg.id,
    author: msg.authorUsername,
    content: msg.content,
    timestamp: new Date(msg.timestamp).toISOString(),
    hasBeenRepliedTo: msg.respondedTo || false,
  }));

  result.push({
    role: "user",
    // Update prompt instruction slightly
    content: `${JSON.stringify(formattedMessages, null, 2)}`
  });

  return result;
}

class LLMEvaluatorService {
  private static instance: LLMEvaluatorService;

  private config: AppConfig | null = null;
  private prompts: PersonaPrompts | null = null;

  private constructor() {
    this.loadConfigAndPrompts();
    loggerService.logger.info("LLMEvaluatorService initialized.");
  }

  /**
   * @description Gets the singleton instance of the LLMEvaluatorService.
   * @returns {LLMEvaluatorService} The singleton instance.
   */
  public static getInstance(): LLMEvaluatorService {
    if (!LLMEvaluatorService.instance) {
      LLMEvaluatorService.instance = new LLMEvaluatorService();
    }
    return LLMEvaluatorService.instance;
  }

  private loadConfigAndPrompts(): void {
    try {
      this.config = configService.getConfig();
      this.prompts = configService.getPersonaPrompts();
      if (!this.config || !this.prompts) {
        loggerService.logger.error(
          "LLMEvaluatorService: Config or Prompts not loaded.",
        );
      }
    } catch (error) {
      loggerService.logger.error(
        "Failed to load config/prompts in LLMEvaluatorService:",
        error,
      );
    }
  }

  /**
   * @description Evaluates a batch of messages using the secondary LLM, considering channel context.
   * @param batchMessages An array of SimpleMessage objects from the current batch to evaluate.
   * @param channelContextMessages An array of SimpleMessage objects representing the broader channel context.
   * @returns A promise resolving to the LLMEvaluationResult or null if an error occurs.
   */
  public async evaluateMessages(
    batchMessages: SimpleMessage[], // Renamed for clarity
    channelContextMessages: SimpleMessage[], // Added context parameter
  ): Promise<LLMEvaluationResult | null> {
    // Validate required configuration for secondary LLM
    if (
      !this.config ||
      !this.prompts ||
      !this.prompts.evaluationPrompt ||
      !this.config.secondaryLlmApiKey ||
      !this.config.secondaryLlmBaseUrl ||
      !this.config.secondaryLlmModel
    ) {
      loggerService.logger.error(
        "Secondary LLM configuration is incomplete. Cannot evaluate messages.",
      );
      return null;
    }

    try {
      // Prepare messages in OpenAI chat completion format, including context
      const chatMessages = formatMessagesForEvaluation(
        channelContextMessages, // Pass context
        batchMessages,          // Pass batch
        this.prompts.evaluationPrompt
      );
      loggerService.logger.debug(`Sending ${chatMessages.length} message parts (system + user with combined context/batch) to LLM Evaluator.`);

      // Call the API using the eval client (for message evaluation)
      const rawContent = await callChatCompletionApi(
        'eval',
        this.config.secondaryLlmModel,
        chatMessages,
        0.2, // Lower temperature for more consistent evaluation
        200  // Enough tokens for evaluation result
      );

      if (!rawContent) {
        throw new Error("LLM API call returned null content.");
      }

      // --- Parse and Validate JSON Response ---
      let result: LLMEvaluationResult | null = null;
      
      // Try to extract JSON from markdown code block first
      const jsonMatch = rawContent.match(/```json\s*([\s\S]+?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const jsonString = jsonMatch[1].trim();
        result = JSON.parse(jsonString) as LLMEvaluationResult;
      } else {
        // Fallback: Try parsing directly
        try {
          result = JSON.parse(rawContent.trim()) as LLMEvaluationResult;
          loggerService.logger.debug("LLM Evaluator response parsed directly as JSON.");
        } catch (parseError) {
          throw new Error(`Could not extract or parse JSON block from LLM evaluator response. Raw: ${rawContent}`);
        }
      }

      // Validate structure
      if (!result || typeof result.should_respond !== 'boolean' || typeof result.reason !== 'string') {
        throw new Error(`Parsed JSON from LLM evaluator has incorrect structure. Parsed: ${JSON.stringify(result)}`);
      }

      // Validate target_message_id if should_respond is true
      if (result.should_respond && result.target_message_id !== null && typeof result.target_message_id !== 'string') {
        loggerService.logger.warn(`LLM evaluator decided to respond but target_message_id is invalid: ${result.target_message_id}. Treating as general response.`);
        result.target_message_id = null; // Default to general response if target is invalid
      }
      if (!result.should_respond) {
        result.target_message_id = null; // Ensure target is null if not responding
      }

      loggerService.logger.info(
        `LLM Evaluation result: should_respond=${result.should_respond}, target_id=${result.target_message_id || "N/A"}`
      );
      return result;

    } catch (error) {
      loggerService.logger.error(`Error during LLM evaluation process:`, error);
      return null;
    }
  }
}

// Export the singleton instance directly
const llmEvaluatorService = LLMEvaluatorService.getInstance();
export default llmEvaluatorService;
export { LLMEvaluatorService }; // Export the class type if needed elsewhere
