import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  PersonaPrompts,
  SimpleMessage,
  SummaryConfig,
  MessageBatch,
} from "@/types";

export interface ResponsePromptContext {
  useCase: "response";
  systemPromptTemplate: string;
  personaDetails: string;
  personaPrompts: PersonaPrompts | null;
  contextMessages: SimpleMessage[];
  languageConfig?: { primary: string; fallback: string; autoDetect: boolean };
  targetMessage?: SimpleMessage;
}

export interface EvaluationPromptContext {
  useCase: "evaluation";
  evaluationPromptTemplate: string;
  personaDetails: string;
  channelContextMessages: SimpleMessage[];
  batchMessages: SimpleMessage[];
  contextLookback?: number;
}

export interface SummaryPromptContext {
  useCase: "summary";
  summaryPromptTemplate: string | null;
  personaPrompts: PersonaPrompts | null;
  summaryConfig: SummaryConfig;
  formattedMessages: string;
  userMappingText: string;
  messageBatch: MessageBatch;
  targetLanguageName: string;
  primaryLanguageCode: string;
  timeRange: string;
}

export type PromptContext =
  | ResponsePromptContext
  | EvaluationPromptContext
  | SummaryPromptContext;

export interface BuiltPrompt {
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
}
