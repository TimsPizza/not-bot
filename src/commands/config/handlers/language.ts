import type { Channel } from "discord.js";
import configService from "@/config";
import type { ConfigCommandContext } from "../types";

export async function handleLanguageSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const { interaction, options, serverConfig } = context;

  const action = options.getString("action", true);
  const language = options.getString("language");
  const targetChannel = options.getChannel("channel") as Channel | null;

  if (!serverConfig.languageConfig) {
    serverConfig.languageConfig = {
      primary: "auto" as any,
      fallback: "en" as any,
      autoDetect: true,
    };
  }

  switch (action) {
    case "set_primary": {
      if (!language) {
        await interaction.editReply(
          "Please specify a language code for the primary language.",
        );
        return;
      }

      if (targetChannel) {
        await interaction.editReply(
          "Channel-specific language settings are not yet implemented. Setting server default.",
        );
        return;
      }

      serverConfig.languageConfig.primary = language as any;
      const success = await configService.saveServerConfig(serverConfig);

      const globalConfig = configService.getConfig();
      const langInfo = globalConfig.language?.supportedLanguages.find(
        (l) => l.code === language,
      );
      const langDisplay = langInfo ? `${langInfo.flag} ${langInfo.name}` : language;

      await interaction.editReply(
        success
          ? `Primary language set to: **${langDisplay}**`
          : "Failed to save language configuration.",
      );
      break;
    }
    case "set_fallback": {
      if (!language) {
        await interaction.editReply(
          "Please specify a language code for the fallback language.",
        );
        return;
      }

      if (language === "auto") {
        await interaction.editReply(
          "Fallback language cannot be 'auto'. Please choose a specific language.",
        );
        return;
      }

      serverConfig.languageConfig.fallback = language as any;
      const success = await configService.saveServerConfig(serverConfig);

      const globalConfig = configService.getConfig();
      const langInfo = globalConfig.language?.supportedLanguages.find(
        (l) => l.code === language,
      );
      const langDisplay = langInfo ? `${langInfo.flag} ${langInfo.name}` : language;

      await interaction.editReply(
        success
          ? `Fallback language set to: **${langDisplay}**`
          : "Failed to save language configuration.",
      );
      break;
    }
    case "toggle_auto": {
      serverConfig.languageConfig.autoDetect =
        !serverConfig.languageConfig.autoDetect;
      const success = await configService.saveServerConfig(serverConfig);

      await interaction.editReply(
        success
          ? `Auto-detection **${serverConfig.languageConfig.autoDetect ? "enabled" : "disabled"}**.`
          : "Failed to save language configuration.",
      );
      break;
    }
    case "view": {
      const langSettings = serverConfig.languageConfig;
      const globalConfig = configService.getConfig();

      const getLangDisplay = (code: string) => {
        const langInfo = globalConfig.language?.supportedLanguages.find(
          (l) => l.code === code,
        );
        return langInfo ? `${langInfo.flag} ${langInfo.name}` : code;
      };

      const langView =
        `**Language Configuration:**\n` +
        `- Primary Language: ${getLangDisplay(langSettings.primary)}\n` +
        `- Fallback Language: ${getLangDisplay(langSettings.fallback)}\n` +
        `- Auto-Detection: ${langSettings.autoDetect ? "✅ Enabled" : "❌ Disabled"}`;

      await interaction.editReply(langView);
      break;
    }
    case "list": {
      const globalConfig = configService.getConfig();
      const supportedLanguages =
        globalConfig.language?.supportedLanguages || [];

      const langList = supportedLanguages
        .map((lang) => `• ${lang.flag} **${lang.name}** (\`${lang.code}\`)`)
        .join("\n");

      await interaction.editReply(`**Supported Languages:**\n${langList}`);
      break;
    }
    default:
      await interaction.editReply("Invalid language action specified.");
      return;
  }
}
