import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  PersonaPrompts,
  SimpleMessage,
  SummaryConfig,
  MessageBatch,
  EmotionSnapshot,
  EmotionMetric,
  ProactiveMessageSummary,
} from "@/types";

export interface ResponsePromptContext {
  useCase: "response";
  systemPromptTemplate: string;
  personaDetails: string;
  personaPrompts: PersonaPrompts | null;
  contextMessages: SimpleMessage[];
  botUserId: string;
  languageConfig?: { primary: string; fallback: string; autoDetect: boolean };
  targetMessage?: SimpleMessage;
  targetUserId?: string;
  emotionSnapshots?: EmotionSnapshot[];
  emotionDeltaCaps?: Partial<Record<EmotionMetric, number>>;
  pendingProactiveMessages?: ProactiveMessageSummary[];
}

export interface EvaluationPromptContext {
  useCase: "evaluation";
  evaluationPromptTemplate: string;
  personaDetails: string;
  botUserId: string;
  channelContextMessages: SimpleMessage[];
  batchMessages: SimpleMessage[];
  contextLookback?: number;
  emotionSnapshots?: EmotionSnapshot[];
  pendingProactiveMessages?: ProactiveMessageSummary[];
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
