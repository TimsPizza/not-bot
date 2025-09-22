import configService from "@/config";
import type { ConfigCommandContext } from "../types";

const MAX_CONTEXT_MESSAGES = 50;
const MIN_CONTEXT_MESSAGES = 1;

export async function handleContextLengthSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const requested = options.getInteger("messages", true);
  const clamped = Math.min(
    MAX_CONTEXT_MESSAGES,
    Math.max(MIN_CONTEXT_MESSAGES, requested),
  );

  serverConfig.maxContextMessages = clamped;
  const success = await configService.saveServerConfig(serverConfig);

  const clampedNotice =
    clamped !== requested
      ? ` (requested ${requested}, capped to ${clamped})`
      : "";

  await interaction.editReply(
    success
      ? `Context history length set to **${clamped}** messages${clampedNotice}.`
      : "Failed to save configuration.",
  );
}
