import {
  BuiltPrompt,
  PromptContext,
  ResponsePromptContext,
  EvaluationPromptContext,
  SummaryPromptContext,
} from "./types";
import { ResponsePromptAssembler } from "./strategies/responseAssembler";
import { EvaluationPromptAssembler } from "./strategies/evaluationAssembler";
import { SummaryPromptAssembler } from "./strategies/summaryAssembler";

const responseAssembler = new ResponsePromptAssembler();
const evaluationAssembler = new EvaluationPromptAssembler();
const summaryAssembler = new SummaryPromptAssembler();

export class PromptBuilder {
  public static build(context: PromptContext): BuiltPrompt {
    switch (context.useCase) {
      case "response":
        return responseAssembler.assemble(context as ResponsePromptContext);
      case "evaluation":
        return evaluationAssembler.assemble(context as EvaluationPromptContext);
      case "summary":
        return summaryAssembler.assemble(context as SummaryPromptContext);
      default:
        throw new Error(
          `Unsupported prompt use case: ${(context as any).useCase}`,
        );
    }
  }
}
