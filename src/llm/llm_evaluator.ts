// src/llm/llm_evaluator.ts
import loggerService from "@/logger";
import configService from "@/config";
import {
  SimpleMessage,
  LLMEvaluationResult,
  PersonaPrompts,
  AppConfig,
} from "@/types";
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
    { role: "system", content: evaluationPrompt },
  ];

  // Combine recent context and the current batch
  const recentContext = channelContextMessages.slice(-contextLookback);
  const messagesToEvaluate = [...recentContext, ...batchMessages];

  // Add a user message containing the combined messages in a clear format
  // We send the combined list for the LLM to understand the flow.
  const formattedMessages = messagesToEvaluate.map((msg) => ({
    id: msg.id,
    author: msg.authorUsername,
    content: msg.content,
    timestamp: new Date(msg.timestamp).toISOString(),
    hasBeenRepliedTo: msg.respondedTo || false,
  }));

  result.push({
    role: "user",
    // Update prompt instruction slightly
    content: `${JSON.stringify(formattedMessages, null, 2)}`,
  });

  return result;
}

class LLMEvaluatorService {
  private static instance: LLMEvaluatorService;

  private config: AppConfig | null = null;
  // Remove prompts property, as templates will be passed in

  private constructor() {
    // Only load AppConfig now
    this.config = configService.getConfig();
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

  // Removed loadConfigAndPrompts as prompts are no longer loaded here

  /**
   * @description Evaluates a batch of messages using the secondary LLM, considering channel context, responsiveness, and specific persona instructions.
   * @param responsiveness The responsiveness factor for the current context (e.g., server).
   * @param evaluationPromptTemplate The base template for the evaluation prompt.
   * @param personaDetails The specific details/instructions for the current persona.
   * @param batchMessages An array of SimpleMessage objects from the current batch to evaluate.
   * @param channelContextMessages An array of SimpleMessage objects representing the broader channel context.
   * @returns A promise resolving to the LLMEvaluationResult or null if an error occurs.
   */
  public async evaluateMessages(
    responsiveness: number,
    evaluationPromptTemplate: string, // Added template
    personaDetails: string, // Added persona details
    batchMessages: SimpleMessage[],
    channelContextMessages: SimpleMessage[],
  ): Promise<LLMEvaluationResult | null> {
    // --- Calculate Effective Threshold ---
    const BASE_RESPONSE_THRESHOLD = 0.5; // Base score needed to consider responding
    // Adjust threshold based on responsiveness: Higher responsiveness = lower threshold
    const effectiveThreshold = Math.max(
      0.01,
      Math.min(1.0, BASE_RESPONSE_THRESHOLD / responsiveness),
    );
    loggerService.logger.debug(
      `Using responsiveness=${responsiveness}, Effective Threshold=${effectiveThreshold.toFixed(2)}`,
    );
    // --------------------------------

    // --------------------------------

    // Validate required configuration for secondary LLM
    // Note: We now check the passed-in template instead of loaded prompts
    if (
      !this.config ||
      !evaluationPromptTemplate || // Check passed template
      !personaDetails || // Ensure persona details are provided
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
      // Inject persona details into the evaluation prompt template.
      // Assumes the template contains a placeholder like {{PERSONA_DETAILS}}.
      // A more robust templating engine could be used if needed.
      const finalEvaluationPrompt = evaluationPromptTemplate.replace(
        /\{\{PERSONA_DETAILS\}\}/g, // Simple placeholder replacement
        personaDetails,
      );
      // Log a warning if the placeholder wasn't found, as it might indicate a template issue
      if (
        !finalEvaluationPrompt.includes(personaDetails) &&
        evaluationPromptTemplate.includes("{{PERSONA_DETAILS}}")
      ) {
        loggerService.logger.warn(
          "Persona details placeholder '{{PERSONA_DETAILS}}' found in evaluation prompt template, but replacement might have failed.",
        );
      }

      // Prepare messages in OpenAI chat completion format, including context
      const chatMessages = formatMessagesForEvaluation(
        channelContextMessages, // Pass context
        batchMessages, // Pass batch
        finalEvaluationPrompt, // Use the prompt with injected persona details
      );
      loggerService.logger.debug(
        `Sending ${chatMessages.length} message parts (system + user with combined context/batch) to LLM Evaluator using effective threshold ${effectiveThreshold.toFixed(2)}.`,
      );

      // Call the API using the eval client (for message evaluation)
      const rawContent = await callChatCompletionApi(
        "eval",
        this.config.secondaryLlmModel,
        chatMessages,
        0.2, // Lower temperature for more consistent evaluation
        200, // Enough tokens for evaluation result
      );

      if (!rawContent) {
        throw new Error("LLM API call returned null content.");
      }

      // --- Parse and Validate JSON Response ---
      let parsedJson: any = null;

      // Try to extract JSON from markdown code block first
      const jsonMatch = rawContent.match(/```json\s*([\s\S]+?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const jsonString = jsonMatch[1].trim();
        parsedJson = JSON.parse(jsonString);
        loggerService.logger.debug(
          "LLM Evaluator response parsed from JSON block.",
        );
      } else {
        // Fallback: Try parsing directly
        try {
          parsedJson = JSON.parse(rawContent.trim());
          loggerService.logger.debug(
            "LLM Evaluator response parsed directly as JSON.",
          );
        } catch (parseError) {
          throw new Error(
            `Could not extract or parse JSON block from LLM evaluator response. Raw: ${rawContent}`,
          );
        }
      }

      // Validate structure based on the new LLMEvaluationResult type
      if (
        !parsedJson ||
        typeof parsedJson.response_score !== "number" ||
        parsedJson.response_score < 0 ||
        parsedJson.response_score > 1 || // Check range
        typeof parsedJson.reason !== "string" ||
        (parsedJson.target_message_id !== null &&
          typeof parsedJson.target_message_id !== "string")
      ) {
        throw new Error(
          `Parsed JSON from LLM evaluator has incorrect structure or invalid values. Parsed: ${JSON.stringify(parsedJson)}`,
        );
      }

      // Construct the final result object
      const result: LLMEvaluationResult = {
        response_score: parsedJson.response_score,
        target_message_id: parsedJson.target_message_id,
        reason: parsedJson.reason,
        // Derive should_respond based on the calculated effective threshold
        should_respond: parsedJson.response_score >= effectiveThreshold,
      };

      // Ensure target_message_id is null if score is below the effective threshold
      if (
        result.response_score < effectiveThreshold &&
        result.target_message_id !== null
      ) {
        loggerService.logger.debug(
          `LLM evaluator provided target_message_id (${result.target_message_id}) but response_score (${result.response_score.toFixed(2)}) is below effective threshold (${effectiveThreshold.toFixed(2)}). Clearing target.`,
        );
        result.target_message_id = null;
      }
      // Also ensure target_message_id is null if should_respond is false (redundant check, but safe)
      if (!result.should_respond) {
        result.target_message_id = null;
      }

      loggerService.logger.info(
        `LLM Evaluation result: response_score=${result.response_score.toFixed(2)}, target_id=${result.target_message_id || "N/A"}`,
      );
      return result; // Return the validated and structured result
    } catch (error) {
      loggerService.logger.error(
        `Error during LLM evaluation process: ${error}`,
      );
      return null;
    }
  }
}

// Export the singleton instance directly
const llmEvaluatorService = LLMEvaluatorService.getInstance();
export default llmEvaluatorService;
export { LLMEvaluatorService }; // Export the class type if needed elsewhere
