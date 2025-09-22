import { handlePersonaSubcommand } from "./persona";
import { handleChannelSubcommand } from "./channel";
import { handleResponsivenessSubcommand } from "./responsiveness";
import { handleLanguageSubcommand } from "./language";
import { handleViewSubcommand } from "./view";
import { handleSummarySubcommand } from "./summary";
import { handleContextLengthSubcommand } from "./contextLength";
import { handleCompletionDelaySubcommand } from "./completionDelay";
import type { ConfigSubcommandHandler } from "../types";

export const groupedHandlers = {
  persona: handlePersonaSubcommand,
} as const;

export const subcommandHandlers: Record<string, ConfigSubcommandHandler> = {
  channel: handleChannelSubcommand,
  responsiveness: handleResponsivenessSubcommand,
  language: handleLanguageSubcommand,
  view: handleViewSubcommand,
  summary: handleSummarySubcommand,
  context: handleContextLengthSubcommand,
  completion_delay: handleCompletionDelaySubcommand,
};

export type GroupedHandlerKey = keyof typeof groupedHandlers;
