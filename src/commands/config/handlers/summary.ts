import { ChannelType, type GuildTextBasedChannel, type Role } from "discord.js";
import configService from "@/config";
import type { ServerConfig } from "@/types";
import type { ConfigCommandContext } from "../types";

function createDefaultSummarySettings() {
  return {
    enabled: false,
    maxMessagesPerSummary: 50,
    cooldownSeconds: 0,
    allowedRoles: [] as string[],
    bannedChannels: [] as string[],
  };
}

function ensureSummarySettings(serverConfig: ServerConfig) {
  if (!serverConfig.summarySettings) {
    serverConfig.summarySettings = createDefaultSummarySettings();
  } else {
    serverConfig.summarySettings.allowedRoles = Array.isArray(
      serverConfig.summarySettings.allowedRoles,
    )
      ? [...new Set(serverConfig.summarySettings.allowedRoles)]
      : [];
    serverConfig.summarySettings.bannedChannels = Array.isArray(
      serverConfig.summarySettings.bannedChannels,
    )
      ? [...new Set(serverConfig.summarySettings.bannedChannels)]
      : [];
  }
  return serverConfig.summarySettings;
}

export async function handleSummarySubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig, subcommand, guildId } = context;
  const summarySettings = ensureSummarySettings(serverConfig);

  switch (subcommand) {
    case "feature": {
      const enabled = options.getBoolean("enabled", true);
      summarySettings.enabled = enabled;
      const success = await configService.saveServerConfig(serverConfig);
      await interaction.editReply(
        success
          ? `Summary feature has been **${enabled ? "enabled" : "disabled"}**.`
          : "Failed to save configuration.",
      );
      break;
    }
    case "channel": {
      if (!guildId) {
        await interaction.editReply(
          "Channel-specific summary rules can only be configured inside a server.",
        );
        return;
      }

      const optionChannel = options.getChannel("channel", false);
      const candidateChannel = optionChannel ?? interaction.channel;

      if (!candidateChannel || candidateChannel.type !== ChannelType.GuildText) {
        await interaction.editReply(
          "Please run this command inside a text channel or specify one explicitly.",
        );
        return;
      }

      const targetChannel = candidateChannel as GuildTextBasedChannel;

      const allowed = options.getBoolean("allowed", true);
      const banned = new Set(summarySettings.bannedChannels ?? []);
      let message: string;
      let changed = false;

      if (allowed) {
        if (banned.delete(targetChannel.id)) {
          message = `Summaries are now **allowed** in <#${targetChannel.id}>.`;
          changed = true;
        } else {
          message = `Summaries were already allowed in <#${targetChannel.id}>.`;
        }
      } else {
        if (!banned.has(targetChannel.id)) {
          banned.add(targetChannel.id);
          message = `Summaries are now **blocked** in <#${targetChannel.id}>.`;
          changed = true;
        } else {
          message = `Summaries were already blocked in <#${targetChannel.id}>.`;
        }
      }

      if (!changed) {
        await interaction.editReply(message);
        return;
      }

      summarySettings.bannedChannels = Array.from(banned);
      const success = await configService.saveServerConfig(serverConfig);
      await interaction.editReply(
        success ? message : "Failed to save configuration.",
      );
      break;
    }
    case "roles": {
      if (!guildId) {
        await interaction.editReply(
          "Role restrictions for summaries are only available inside servers.",
        );
        return;
      }

      const action = options.getString("action", true);
      const role = options.getRole("role", false) as Role | null;
      const allowedRoles = new Set(summarySettings.allowedRoles ?? []);
      let message: string;
      let changed = false;

      switch (action) {
        case "add": {
          if (!role) {
            await interaction.editReply("Please specify a role to add.");
            return;
          }
          if (allowedRoles.has(role.id)) {
            message = `${role} is already allowed to request summaries.`;
          } else {
            allowedRoles.add(role.id);
            message = `${role} can now request summaries.`;
            changed = true;
          }
          break;
        }
        case "remove": {
          if (!role) {
            await interaction.editReply("Please specify a role to remove.");
            return;
          }
          if (allowedRoles.delete(role.id)) {
            message = `${role} can no longer request summaries.`;
            changed = true;
          } else {
            message = `${role} was not in the allow list.`;
          }
          break;
        }
        case "clear": {
          if (allowedRoles.size === 0) {
            message = "The summary allow list is already empty.";
          } else {
            allowedRoles.clear();
            message = "Cleared all summary role restrictions.";
            changed = true;
          }
          break;
        }
        case "list": {
          if (allowedRoles.size === 0) {
            message = "No roles are currently required to use the summary feature.";
          } else {
            const mentions = Array.from(allowedRoles).map(
              (roleId) => `<@&${roleId}>`,
            );
            message = `Allowed roles: ${mentions.join(", ")}`;
          }
          await interaction.editReply(message);
          return;
        }
        default:
          await interaction.editReply("Unknown roles action.");
          return;
      }

      if (!changed) {
        await interaction.editReply(message);
        return;
      }

      summarySettings.allowedRoles = Array.from(allowedRoles);
      const success = await configService.saveServerConfig(serverConfig);
      await interaction.editReply(
        success ? message : "Failed to save configuration.",
      );
      break;
    }
    default:
      await interaction.editReply("Unknown summary action.");
  }
}
