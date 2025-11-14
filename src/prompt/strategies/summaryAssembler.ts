import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { SummaryPromptContext } from "../types";
import { BasePromptAssembler } from "./base";
import { renderTemplate } from "../template";

const SUMMARY_SYSTEM_MESSAGE =
  "You are a precise chat log summarizer. Produce concise, helpful summaries that follow the requested language and format.";

const DEFAULT_SUMMARY_TEMPLATE = `Analyze the following Discord conversation and provide a concise summary in {{target_language}}.

Summary guidelines:
1. Remain neutral and fact-focused.
2. Highlight major topics and actionable conclusions.
3. Ignore spam, bot noise, and irrelevant chatter.
4. When mentioning users, always use the provided Discord mention format (e.g., <@123456789>).
5. Direction: {{summary_direction}}.
6. Total messages in batch: {{message_count}} spanning {{time_range}}.
{{language_instruction}}

Chat log:
{{messages_content}}

Your response must include:
- Main topics
- Key discussion points
- Decisions or action items
- Open questions or follow-ups (if any)`;

export class SummaryPromptAssembler extends BasePromptAssembler<SummaryPromptContext> {
  protected buildSystemRules(
    context: SummaryPromptContext,
  ): ChatCompletionMessageParam {
    const mappingBlock = context.userMappingText
      ? buildUsernameMappingBlockFromSummary(context.userMappingText)
      : null;

    const sections = [SUMMARY_SYSTEM_MESSAGE];
    if (mappingBlock) {
      sections.push(mappingBlock);
    }

    return {
      role: "system",
      content: sections.join("\n\n"),
    };
  }

  protected buildContextMessages(
    context: SummaryPromptContext,
  ): ChatCompletionMessageParam[] {
    const {
      summaryPromptTemplate,
      personaPrompts,
      summaryConfig,
      formattedMessages,
      userMappingText,
      messageBatch,
      targetLanguageName,
      primaryLanguageCode,
      timeRange,
    } = context;

    const summaryPrompts = personaPrompts?.summary_prompts;
    const template =
      summaryPromptTemplate ??
      summaryPrompts?.basic_summary ??
      DEFAULT_SUMMARY_TEMPLATE;

    const directionKey = summaryConfig.direction ?? "forward";
    const directionInstruction =
      summaryPrompts?.direction_instructions?.[directionKey] ??
      getSummaryDirectionDescription(directionKey);

    const languageStyle =
      (summaryPrompts?.summary_styles || {})[primaryLanguageCode] ?? "";

    const renderedPrompt = renderTemplate(template, {
      target_language: targetLanguageName,
      summary_direction: directionInstruction,
      messages_content: formattedMessages,
      message_count: messageBatch.totalCount,
      time_range: timeRange,
      language_instruction: languageStyle,
    });

    return [
      {
        role: "user",
        content: renderedPrompt,
      },
    ];
  }

  protected buildOutputSchema(): ChatCompletionMessageParam | null {
    return null;
  }

  protected getTemperature(): number {
    return 0.95;
  }

  protected getMaxTokens(): number {
    return 1500;
  }
}

function getSummaryDirectionDescription(direction: string): string {
  switch (direction) {
    case "forward":
      return "Summarize the conversation that happened after the reference message.";
    case "backward":
      return "Summarize what happened before the reference message.";
    case "around":
      return "Summarize the complete discussion around the reference message.";
    default:
      return direction;
  }
}

function buildUsernameMappingBlockFromSummary(
  mappingText: string,
): string | null {
  if (!mappingText.trim()) {
    return null;
  }

  return [
    "User mention directory:",
    mappingText,
    "Always use the mention IDs above when referencing users.",
  ].join("\n");
}
