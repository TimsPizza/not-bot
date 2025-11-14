import configService from "@/config";
import loggerService from "@/logger";
import type { ConfigCommandContext } from "../types";

export async function handleViewSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, serverConfig } = context;
  loggerService.logger.debug(
    { serverId: serverConfig.serverId },
    "Viewing server configuration.",
  );

  const allowed = serverConfig.allowedChannels
    ? serverConfig.allowedChannels.map((id) => `<#${id}>`).join(", ")
    : "None";

  const defaultMapping = serverConfig.personaMappings["default"];
  let personaInfo = "Not Set";
  if (defaultMapping) {
    personaInfo = `Type: ${defaultMapping.type}, ID: ${defaultMapping.id}`;
  }

  let languageInfo = "Not Set";
  if (serverConfig.languageConfig) {
    const globalConfig = configService.getConfig();
    const getLangDisplay = (code: string) => {
      const langInfo = globalConfig.language?.supportedLanguages.find(
        (l) => l.code === code,
      );
      return langInfo ? `${langInfo.flag} ${langInfo.name}` : code;
    };

    languageInfo =
      `Primary: ${getLangDisplay(serverConfig?.languageConfig?.primary)}, ` +
      `Fallback: ${getLangDisplay(serverConfig?.languageConfig?.fallback)}, ` +
      `Auto-detect: ${serverConfig?.languageConfig?.autoDetect ? "On" : "Off"}`;
  }

  const personaOverrides = Object.entries(serverConfig.personaMappings || {})
    .filter(([key]) => key !== "default")
    .map(([channelId, ref]) => `• <#${channelId}> → ${ref.type}:${ref.id}`);
  const personaOverrideInfo =
    personaOverrides.length > 0
      ? personaOverrides.join("\n")
      : "None (using default persona everywhere)";

  const summaryInfo = serverConfig.summarySettings
    ? [
        `Enabled: ${serverConfig.summarySettings.enabled ? "Yes" : "No"}`,
        `Max Messages/Summary: ${serverConfig.summarySettings.maxMessagesPerSummary}`,
        `Cooldown: ${serverConfig.summarySettings.cooldownSeconds}s`,
        `Allowed Roles: ${
          serverConfig.summarySettings.allowedRoles?.length
            ? serverConfig.summarySettings.allowedRoles
                .map((id) => `<@&${id}>`)
                .join(", ")
            : "All"
        }`,
        `Banned Channels: ${
          serverConfig.summarySettings.bannedChannels?.length
            ? serverConfig.summarySettings.bannedChannels
                .map((id) => `<#${id}>`)
                .join(", ")
            : "None"
        }`,
      ].join("\n")
    : "Not configured (summary feature disabled)";

  const channelRuleInfo = serverConfig.channelConfig
    ? [
        `Mode: ${serverConfig.channelConfig.mode}`,
        `Auto-manage: ${serverConfig.channelConfig.autoManage ? "Yes" : "No"}`,
        `List: ${
          serverConfig.channelConfig.allowedChannels.length
            ? serverConfig.channelConfig.allowedChannels
                .map((id) => `<#${id}>`)
                .join(", ")
            : "Empty"
        }`,
      ].join("\n")
    : "Not configured";

  const advancedInfo = [
    `Max Context Messages: ${serverConfig.maxContextMessages ?? "Default"}`,
    `Max Daily Responses: ${serverConfig.maxDailyResponses ?? "Default"}`,
    `Completion Delay: ${
      typeof serverConfig.completionDelaySeconds === "number"
        ? `${serverConfig.completionDelaySeconds}s`
        : "Default"
    }`,
  ].join("\n");

  const configView =
    `**Current Server Configuration:**\n` +
    `- Allowed Channels: ${allowed}\n` +
    `- Responsiveness: ${serverConfig.responsiveness}\n` +
    `- Default Persona Mapping: ${personaInfo}\n` +
    `- Language Settings: ${languageInfo}\n\n` +
    `**Persona Overrides:**\n${personaOverrideInfo}\n\n` +
    `**Advanced Limits:**\n${advancedInfo}\n\n` +
    `**Summary Settings:**\n${summaryInfo}\n\n` +
    `**Channel Rules:**\n${channelRuleInfo}`;

  await interaction.editReply(configView);
}
