import configService from "@/config";
import type { ConfigCommandContext } from "../types";

const MIN_COMPLETION_DELAY = 3;
const MAX_COMPLETION_DELAY = 120;

export async function handleCompletionDelaySubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const requested = options.getInteger("seconds", true);
  const clamped = Math.min(
    MAX_COMPLETION_DELAY,
    Math.max(MIN_COMPLETION_DELAY, requested),
  );

  serverConfig.completionDelaySeconds = clamped;
  const success = await configService.saveServerConfig(serverConfig);

  const clampedNotice =
    clamped !== requested
      ? ` (requested ${requested}, capped to ${clamped})`
      : "";

  await interaction.editReply(
    success
      ? `Completion delay set to **${clamped}** seconds${clampedNotice}.`
      : "Failed to save configuration.",
  );
}
