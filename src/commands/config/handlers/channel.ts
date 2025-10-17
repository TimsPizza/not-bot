import type { Channel } from "discord.js";
import { ChannelType } from "discord.js";
import configService from "@/config";
import loggerService from "@/logger";
import type { ConfigCommandContext } from "../types";

export async function handleChannelSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const action = options.getString("action", true);
  const targetChannel = options.getChannel("channel") as Channel | null;

  const channelToConfig = targetChannel || interaction.channel;

  if (!channelToConfig || channelToConfig.type !== ChannelType.GuildText) {
    await interaction.editReply(
      "Invalid channel. Please select a text channel or use this command in a text channel.",
    );
    return;
  }

  const channelId = channelToConfig.id;
  const allowedBefore = serverConfig.allowedChannels
    ? [...serverConfig.allowedChannels]
    : [];
  let allowed = serverConfig.allowedChannels || [];
  let message: string;

  loggerService.logger.debug(
    {
      guildId: serverConfig.serverId,
      requestedAction: action,
      targetChannel: channelId,
      allowedBefore,
    },
    "Handling config channel subcommand.",
  );

  switch (action) {
    case "enable":
      if (!allowed.includes(channelId)) {
        allowed.push(channelId);
        message = `Bot is now **enabled** in channel <#${channelId}>.`;
      } else {
        message = `Bot is already enabled in channel <#${channelId}>.`;
      }
      break;
    case "disable":
      if (allowed.includes(channelId)) {
        allowed = allowed.filter((id) => id !== channelId);
        message = `Bot is now **disabled** in channel <#${channelId}>.`;
      } else {
        message = `Bot is already disabled in channel <#${channelId}>.`;
      }
      break;
    case "toggle":
      if (allowed.includes(channelId)) {
        allowed = allowed.filter((id) => id !== channelId);
        message = `Bot is now **disabled** in channel <#${channelId}>.`;
      } else {
        allowed.push(channelId);
        message = `Bot is now **enabled** in channel <#${channelId}>.`;
      }
      break;
    default:
      await interaction.editReply("Invalid action specified.");
      return;
  }

  serverConfig.allowedChannels = allowed.length > 0 ? allowed : null;
  loggerService.logger.debug(
    {
      guildId: serverConfig.serverId,
      targetChannel: channelId,
      allowedAfter: serverConfig.allowedChannels,
    },
    "Persisting allowed channel configuration.",
  );
  const success = await configService.saveServerConfig(serverConfig);
  loggerService.logger.info(
    {
      guildId: serverConfig.serverId,
      targetChannel: channelId,
      persistedAllowedChannels: serverConfig.allowedChannels,
      saveSucceeded: success,
    },
    "Completed config channel subcommand.",
  );
  await interaction.editReply(success ? message : "Failed to save configuration.");
}
