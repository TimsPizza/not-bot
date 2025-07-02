import { REST } from "@discordjs/rest";
import {
  Routes,
  APIApplicationCommandOptionChoice,
} from "discord-api-types/v10";
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import dotenv from "dotenv";
import loggerService from "@/logger";
import configService from "@/config"; // To potentially load persona list later
import { messageSummaryCommand } from "./context/summarize.js";

dotenv.config();

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_BOT_TOKEN!,
);

(async () => {
  try {
    const clientId = process.env.DISCORD_CLIENT_ID;
    // Optional: For testing in a specific guild
    // UNUSED, FOR NOW
    const guildId = process.env.DISCORD_TEST_GUILD_ID; 

    if (!clientId) {
      loggerService.logger.error(
        "DISCORD_CLIENT_ID is not defined in environment variables.",
      );
      return;
    }

    const commands = [
      new SlashCommandBuilder()
        .setName("config")
        .setDescription("Configure the bot settings for this server")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("view")
            .setDescription("View current configuration"),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("channel")
            .setDescription("Configure bot channels")
            .addStringOption((option) =>
              option
                .setName("action")
                .setDescription("Action to perform")
                .setRequired(true)
                .addChoices(
                  { name: "Enable", value: "enable" },
                  { name: "Disable", value: "disable" },
                  { name: "Toggle", value: "toggle" },
                ),
            )
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Channel to configure")
                .setRequired(false),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("responsiveness")
            .setDescription("Set bot responsiveness (0.1 - 2.0)")
            .addNumberOption((option) =>
              option
                .setName("value")
                .setDescription(
                  "Responsiveness value, high is more responsive, low is less responsive",
                )
                .setRequired(true)
                .setMinValue(0.1)
                .setMaxValue(2.0),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("persona")
            .setDescription("Configure bot persona")
            .addStringOption((option) =>
              option
                .setName("action")
                .setDescription("Action to perform")
                .setRequired(true)
                .addChoices(
                  { name: "Set", value: "set" },
                  { name: "List", value: "list" },
                ),
            )
            .addStringOption((option) =>
              option
                .setName("persona")
                .setDescription("Persona to set")
                .setRequired(false),
            )
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Channel to configure")
                .setRequired(false),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("language")
            .setDescription("Configure bot language settings")
            .addStringOption((option) =>
              option
                .setName("action")
                .setDescription("Action to perform")
                .setRequired(true)
                .addChoices(
                  { name: "Set Primary", value: "set_primary" },
                  { name: "Set Fallback", value: "set_fallback" },
                  { name: "Toggle Auto-detect", value: "toggle_auto" },
                  { name: "View", value: "view" },
                  { name: "List Supported", value: "list" },
                ),
            )
            .addStringOption((option) =>
              option
                .setName("language")
                .setDescription("Language code to set")
                .setRequired(false)
                .addChoices(
                  { name: "🤖 Auto Detect", value: "auto" },
                  { name: "🇨🇳 中文", value: "zh" },
                  { name: "🇺🇸 English", value: "en" },
                  { name: "🇯🇵 日本語", value: "ja" },
                  { name: "🇰🇷 한국어", value: "ko" },
                  { name: "🇪🇸 Español", value: "es" },
                  { name: "🇫🇷 Français", value: "fr" },
                  { name: "🇩🇪 Deutsch", value: "de" },
                  { name: "🇷🇺 Русский", value: "ru" },
                  { name: "🇵🇹 Português", value: "pt" },
                ),
            )
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Channel to configure (optional)")
                .setRequired(false),
            ),
        ),
    ];

    // 添加上下文菜单命令
    const contextMenuCommands = [messageSummaryCommand];

    loggerService.logger.info("Started refreshing application commands.");

    // 组合所有命令进行注册
    const allCommands = [
      ...commands.map((cmd) => cmd.toJSON()),
      ...contextMenuCommands,
    ];

    const data = await rest.put(
      guildId
        ? Routes.applicationGuildCommands(clientId, guildId)
        : Routes.applicationCommands(clientId),
      { body: allCommands },
    );

    loggerService.logger.info(
      `Successfully reloaded ${(data as any[]).length} application commands.`,
    );
  } catch (error) {
    loggerService.logger.error("Error refreshing commands:", error);
  }
})();
