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

dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure bot settings for this server")
    // .setDescription("Configure bot settings for this server (Admin only)")
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Only admins can use
    .setDMPermission(true) // Not available in DMs
    .addSubcommand((subcommand) =>
      subcommand
        .setName("allow_channel")
        .setDescription(
          "Add or remove a channel where the bot is allowed to speak",
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("The channel to allow/disallow")
            .addChannelTypes(ChannelType.GuildText) // Only allow text channels
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set_responsiveness")
        .setDescription(
          "Set how responsive the bot is (0.1=less, 1.0=normal, 2.0=more)",
        )
        .addNumberOption((option) =>
          option
            .setName("value")
            .setDescription("Responsiveness value (e.g., 0.5, 1.0, 1.5)")
            .setRequired(true)
            .setMinValue(0.1) // Set reasonable bounds
            .setMaxValue(2.0),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set_persona")
        .setDescription("Set the persona the bot uses in this server")
        .addStringOption((option) => {
          option
            .setName("persona")
            .setDescription("The preset persona ID to use")
            .setRequired(true);

          // Dynamically load preset persona choices
          try {
            const presetPersonas = configService.getAvailablePresetPersonas(); // Get loaded presets
            const choices: APIApplicationCommandOptionChoice<string>[] = [];
            presetPersonas.forEach((persona, id) => {
              // Limit choice name length if necessary (Discord limit is 100)
              const choiceName =
                persona.name.length > 90
                  ? `${persona.name.substring(0, 90)}... (${id})`
                  : `${persona.name} (${id})`;
              choices.push({ name: choiceName, value: id });
            });

            if (choices.length > 0) {
              // Discord limits choices to 25
              option.addChoices(...choices.slice(0, 25));
            } else {
              loggerService.logger.warn(
                "No preset personas found to add as choices for /config set_persona command.",
              );
              // Add a placeholder choice if none are loaded? Or rely on validation in handler?
              // Let's rely on validation in the handler for now.
            }
          } catch (error) {
            loggerService.logger.error(
              "Failed to load preset personas for command choices:",
              error,
            );
            // Add a fallback choice indicating an error?
            option.addChoices({
              name: "Error loading personas",
              value: "_error",
            });
          }

          return option;
        }),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View the current bot configuration for this server"),
    ),
  // Add other top-level commands here if needed
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_BOT_TOKEN!,
);

(async () => {
  try {
    const clientId = process.env.DISCORD_CLIENT_ID;
    // const guildId = process.env.DISCORD_TEST_GUILD_ID; // Optional: For testing in a specific guild

    if (!clientId) {
      throw new Error(
        "DISCORD_CLIENT_ID is not defined in environment variables.",
      );
    }

    loggerService.logger.info("Started refreshing application (/) commands.");

    // Use applicationCommands for global commands
    // Use applicationGuildCommands for guild-specific commands (replace Routes.applicationCommands with Routes.applicationGuildCommands(clientId, guildId))
    await rest.put(
      Routes.applicationCommands(clientId),
      // Routes.applicationGuildCommands(clientId, guildId!), // Uncomment for guild-specific testing
      { body: commands },
    );

    loggerService.logger.info(
      "Successfully reloaded application (/) commands.",
    );
  } catch (error) {
    loggerService.logger.error("Error refreshing application commands:", error);
  }
})();
