import configService from "@/config";
import type { ConfigCommandContext } from "../types";

export async function handleSummarySubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const enabled = options.getBoolean("enabled", true);

  const summarySettings = serverConfig.summarySettings ?? {
    enabled: false,
    maxMessagesPerSummary: 50,
    cooldownSeconds: 0,
    allowedRoles: [],
    bannedChannels: [],
  };

  summarySettings.enabled = enabled;
  serverConfig.summarySettings = summarySettings;

  const success = await configService.saveServerConfig(serverConfig);
  await interaction.editReply(
    success
      ? `Summary feature has been **${enabled ? "enabled" : "disabled"}**.`
      : "Failed to save configuration.",
  );
}
