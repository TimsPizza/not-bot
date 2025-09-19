import { handlePersonaSubcommand } from "./persona";
import { handleChannelSubcommand } from "./channel";
import { handleResponsivenessSubcommand } from "./responsiveness";
import { handleLanguageSubcommand } from "./language";
import { handleViewSubcommand } from "./view";
import type { ConfigSubcommandHandler } from "../types";

export const groupedHandlers = {
  persona: handlePersonaSubcommand,
} as const;

export const subcommandHandlers: Record<string, ConfigSubcommandHandler> = {
  channel: handleChannelSubcommand,
  responsiveness: handleResponsivenessSubcommand,
  language: handleLanguageSubcommand,
  view: handleViewSubcommand,
};

export type GroupedHandlerKey = keyof typeof groupedHandlers;
