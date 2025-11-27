import {
  BuiltPrompt,
  PromptContext,
  ResponsePromptContext,
  EvaluationPromptContext,
  SummaryPromptContext,
  TopicStarterPromptContext,
} from "./types";
import { ResponsePromptAssembler } from "./strategies/responseAssembler";
import { EvaluationPromptAssembler } from "./strategies/evaluationAssembler";
import { SummaryPromptAssembler } from "./strategies/summaryAssembler";
import { TopicStarterPromptAssembler } from "./strategies/topicStarterAssembler";

const responseAssembler = new ResponsePromptAssembler();
const evaluationAssembler = new EvaluationPromptAssembler();
const summaryAssembler = new SummaryPromptAssembler();
const topicStarterAssembler = new TopicStarterPromptAssembler();

export class PromptBuilder {
  public static build(context: PromptContext): BuiltPrompt {
    switch (context.useCase) {
      case "response":
        return responseAssembler.assemble(context as ResponsePromptContext);
      case "evaluation":
        return evaluationAssembler.assemble(context as EvaluationPromptContext);
      case "summary":
        return summaryAssembler.assemble(context as SummaryPromptContext);
      case "topicStarter":
        return topicStarterAssembler.assemble(
          context as TopicStarterPromptContext,
        );
      default:
        throw new Error(
          `Unsupported prompt use case: ${(context as any).useCase}`,
        );
    }
  }
}
