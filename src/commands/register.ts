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

const availablePresetPersonas = configService.getAvailablePresetPersonas();
const personaChoices: APIApplicationCommandOptionChoice<string>[] = [];

for (const persona of Array.from(availablePresetPersonas.values()).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (personaChoices.length >= 25) {
    loggerService.logger.warn(
      "Persona choice list exceeded Discord's limit of 25 options. Truncating.",
    );
    break;
  }

  const trimmedName =
    persona.name.length <= 100
      ? persona.name
      : `${persona.name.slice(0, 97)}...`;

  personaChoices.push({
    name: trimmedName,
    value: persona.id,
  });
}

if (personaChoices.length === 0) {
  loggerService.logger.warn(
    "No preset personas available when registering commands. Persona selection choices will be empty.",
  );
}

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
        .addSubcommandGroup((group) =>
          group
            .setName("persona")
            .setDescription("Configure bot persona")
            .addSubcommand((subcommand) =>
              subcommand
                .setName("set")
                .setDescription("Set the persona for this channel")
                .addStringOption((option) =>
                  option
                    .setName("persona")
                    .setDescription("Persona to use for this channel")
                    .setRequired(true)
                    .addChoices(...personaChoices),
                ),
            )
            .addSubcommand((subcommand) =>
              subcommand
                .setName("list")
                .setDescription("List available personas and show the active one"),
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
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("summary")
            .setDescription("Enable or disable the summary feature")
            .addBooleanOption((option) =>
              option
                .setName("enabled")
                .setDescription("Whether to enable summaries")
                .setRequired(true),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("context")
            .setDescription("Set additional context length (max 50 messages)")
            .addIntegerOption((option) =>
              option
                .setName("messages")
                .setDescription(
                  "Number of recent messages to keep in context (1-50)",
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(50),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("completion_delay")
            .setDescription(
              "Set wait time before sending completion requests (seconds)",
            )
            .addIntegerOption((option) =>
              option
                .setName("seconds")
                .setDescription("Delay before requesting LLM completion (>= 3)")
                .setRequired(true)
                .setMinValue(3)
                .setMaxValue(120),
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
    loggerService.logger.error({ err: error }, "Error refreshing commands");
  }
})();
