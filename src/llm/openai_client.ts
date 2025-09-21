// src/llm/openai_client.ts
import OpenAI from "openai";
import loggerService from "@/logger";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import configService from "@/config";

const config = configService.getConfig();

const EVAL_CLIENT = new OpenAI({
  baseURL: config.secondaryLlmBaseUrl,
  apiKey: config.secondaryLlmApiKey,
});

const MAIN_CLIENT = new OpenAI({
  baseURL: config.primaryLlmBaseUrl,
  apiKey: config.primaryLlmApiKey,
});

/**
 * @description Calls an OpenAI-compatible chat completion API.
 * @param apiKey The API key.
 * @param baseUrl The base URL of the API.
 * @param model The model name to use.
 * @param messages The array of messages in OpenAI format (system, user, assistant).
 * @param clientType Specifies which client to use ('main' or 'eval').
 * @param model The model name to use.
 * @param messages The array of messages in OpenAI format (system, user, assistant).
 * @param temperature The sampling temperature.
 * @param maxTokens The maximum number of tokens to generate.
 * @returns The generated content string or null if an error occurs.
 */
export async function callChatCompletionApi(
  clientType: "main" | "eval", // Specify which client to use
  model: string,
  messages: ChatCompletionMessageParam[],
  temperature: number,
  maxTokens: number,
): Promise<string | null> {
  // Ensure config is loaded before proceeding
  if (!config) {
    loggerService.logger.error(
      { module: "openai_client", reason: "config not loaded" },
      "Configuration missing. Cannot call LLM API",
    );
    return null;
  }

  const client = clientType === "main" ? MAIN_CLIENT : EVAL_CLIENT;
  const clientIdentifier = clientType === "main" ? "Primary" : "Secondary"; // For logging
  // Config is checked above, so these should be safe now. Add '!' for assertion if needed, but check is better.

  try {
    loggerService.logger.debug(
      `Calling ${clientIdentifier} Chat Completion API: ${model} at ${client.baseURL} with ${messages.length} messages.`,
    );

    const response = await client.chat.completions.create({
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens,
    });

    // 确保响应中有选项并且第一个选项有内容
    const choices = response?.choices;
    if (!choices || choices.length === 0) {
      throw new Error(`No choices returned from LLM API at ${client.baseURL}`);
    }

    const content = choices[0]?.message?.content;
    if (!content) {
      throw new Error(
        `No content in response from LLM API at ${client.baseURL}`,
      );
    }
    loggerService.logger.debug(`LLM API Response content: "${content}"`);
    return content;
  } catch (error: unknown) {
    // Use unknown for better type safety
    // Log specific OpenAI API errors if available
    if (error instanceof OpenAI.APIError) {
      const status = error.status ?? "N/A";
      const errName = error.name ?? "UnknownAPIError";
      const errMessage = error.message ?? "No message";
      // Use optional chaining for error.error before stringifying
      const errDetails = error.error
        ? JSON.stringify(error.error)
        : "No details";
      loggerService.logger.error(
        {
          status,
          errName,
          errMessage,
          details: errDetails,
          model,
          clientIdentifier,
        },
        "OpenAI API error",
      );
    } else if (error instanceof Error) {
      // Handle generic Error objects
      const errName = error.name ?? "Error";
      const errMessage = error.message ?? "No message";
      loggerService.logger.error(
        { errName, errMessage, model, clientIdentifier },
        "Generic error calling LLM API",
      );
      // Safely log the stack if it exists
      if (typeof error.stack === "string") {
        loggerService.logger.error({ stack: error.stack }, "Stack trace");
      }
    } else {
      // Handle other types of errors
      loggerService.logger.error(
        { err: error, model, clientIdentifier },
        "Unknown error calling LLM API",
      );
    }
    return null; // Return null on error
  }
}
