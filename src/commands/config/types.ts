import type { ChatInputCommandInteraction, CacheType } from "discord.js";
import type { ServerConfig } from "@/types";

export interface ConfigCommandContext {
  interaction: ChatInputCommandInteraction<CacheType>;
  options: ChatInputCommandInteraction<CacheType>["options"];
  serverConfig: ServerConfig;
  isDm: boolean;
  guildId: string | null;
  channelId: string | null;
  subcommand: string;
  subcommandGroup: string | null;
  commandDescriptor: string;
}

export type ConfigSubcommandHandler = (
  context: ConfigCommandContext,
) => Promise<void>;
