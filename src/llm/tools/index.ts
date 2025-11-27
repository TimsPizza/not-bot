import loggerService from "@/logger";
import { BraveSearchClient } from "@agentic/brave-search";
import { ExaClient } from "@agentic/exa";
import { AIFunctionLike, AIFunctionSet } from "@agentic/core";
import { ChatCompletionTool } from "openai/resources/chat/completions";

class AgenticToolService {
  private static instance: AgenticToolService;

  private toolSet: AIFunctionSet;

  private constructor() {
    const providers: AIFunctionLike[] = [];

    const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveApiKey) {
      try {
        const braveClient = new BraveSearchClient({
          apiKey: braveApiKey,
        });
        providers.push(braveClient.functions) as unknown as AIFunctionLike;
      } catch (error) {
        loggerService.logger.error(
          { err: error },
          "Failed to initialize BraveSearchClient. Tool will be unavailable.",
        );
      }
    } else {
      loggerService.logger.debug(
        "BRAVE_SEARCH_API_KEY not set. Brave search tools will be disabled.",
      );
    }

    const exaApiKey = process.env.EXA_API_KEY;
    if (exaApiKey) {
      try {
        const exaClient = new ExaClient({
          apiKey: exaApiKey,
          apiBaseUrl: process.env.EXA_API_BASE_URL,
        });
        providers.push(exaClient.functions as unknown as AIFunctionLike);
      } catch (error) {
        loggerService.logger.error(
          { err: error },
          "Failed to initialize ExaClient. Tool will be unavailable.",
        );
      }
    } else {
      loggerService.logger.debug(
        "EXA_API_KEY not set. Exa tools will be disabled.",
      );
    }

    this.toolSet = new AIFunctionSet(providers);

    loggerService.logger.info(
      { registeredToolCount: this.toolSet.size },
      "Agentic tool service initialized.",
    );
  }

  public static getInstance(): AgenticToolService {
    if (!AgenticToolService.instance) {
      AgenticToolService.instance = new AgenticToolService();
    }
    return AgenticToolService.instance;
  }

  public hasTools(): boolean {
    return this.toolSet.size > 0;
  }

  public getToolSpecs(): ChatCompletionTool[] {
    return this.toolSet.toolSpecs as ChatCompletionTool[];
  }

  public async executeToolCall(
    toolName: string,
    rawArguments: string,
  ): Promise<unknown> {
    const fn = this.toolSet.get(toolName);
    if (!fn) {
      throw new Error(`Unknown tool requested: ${toolName}`);
    }

    loggerService.logger.info({ toolName }, "Executing Agentic tool call.");

    return fn(rawArguments);
  }
}

const agenticToolService = AgenticToolService.getInstance();
export default agenticToolService;
