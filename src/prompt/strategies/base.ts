import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { BuiltPrompt, PromptContext } from "../types";

export interface PromptAssembler<T extends PromptContext> {
  assemble(context: T): BuiltPrompt;
}

export abstract class BasePromptAssembler<T extends PromptContext>
  implements PromptAssembler<T>
{
  public assemble(context: T): BuiltPrompt {
    const messages: ChatCompletionMessageParam[] = [];

    const systemRules = this.buildSystemRules(context);
    messages.push(systemRules);

    const contextMessages = this.buildContextMessages(context);
    messages.push(...contextMessages);

    const outputSchema = this.buildOutputSchema(context);
    if (outputSchema) {
      messages.push(outputSchema);
    }

    return {
      messages,
      temperature: this.getTemperature(context),
      maxTokens: this.getMaxTokens(context),
    };
  }

  protected abstract buildSystemRules(
    context: T,
  ): ChatCompletionMessageParam;

  protected abstract buildContextMessages(
    context: T,
  ): ChatCompletionMessageParam[];

  protected abstract buildOutputSchema(
    context: T,
  ): ChatCompletionMessageParam | null;

  protected abstract getTemperature(context: T): number;

  protected abstract getMaxTokens(context: T): number;
}
