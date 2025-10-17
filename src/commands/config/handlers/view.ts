import configService from "@/config";
import type { ConfigCommandContext } from "../types";

export async function handleViewSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, serverConfig } = context;
  console.log(`Viewing config for server: ${serverConfig.serverId}: ${serverConfig}` );

  const allowed = serverConfig.allowedChannels
    ? serverConfig.allowedChannels.map((id) => `<#${id}>`).join(", ")
    : "All Channels";

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

  const configView =
    `**Current Server Configuration:**\n` +
    `- Allowed Channels: ${allowed}\n` +
    `- Responsiveness: ${serverConfig.responsiveness}\n` +
    `- Default Persona Mapping: ${personaInfo}\n` +
    `- Language Settings: ${languageInfo}`;

  await interaction.editReply(configView);
}
