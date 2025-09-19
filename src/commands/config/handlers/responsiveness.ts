import configService from "@/config";
import type { ConfigCommandContext } from "../types";

export async function handleResponsivenessSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const value = options.getNumber("value", true);
  serverConfig.responsiveness = value;
  const success = await configService.saveServerConfig(serverConfig);
  await interaction.editReply(
    success
      ? `Responsiveness set to **${value}**.`
      : "Failed to save configuration.",
  );
}
