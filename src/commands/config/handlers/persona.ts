import configService from "@/config";
import type { PersonaDefinition } from "@/types";
import { PersonaType } from "@/types";
import type { ConfigCommandContext } from "../types";

export async function handlePersonaSubcommand(
  context: ConfigCommandContext,
): Promise<void> {
  const {
    interaction,
    options,
    serverConfig,
    isDm,
    guildId,
    subcommand,
  } = context;

  const invokingChannelId = interaction.channelId;
  if (!invokingChannelId) {
    await interaction.editReply(
      "Unable to determine the current channel for persona configuration.",
    );
    return;
  }

  const channelLabel = guildId
    ? `<#${invokingChannelId}>`
    : "this DM conversation";
  const contextNoun = guildId ? "channel" : "conversation";

  switch (subcommand) {
    case "set": {
      const presetId = options.getString("persona", true);
      const presetPersona = configService.getPresetPersona(presetId);

      if (!presetPersona) {
        await interaction.editReply(
          `Error: Preset persona with ID '${presetId}' not found.`,
        );
        return;
      }

      serverConfig.personaMappings[invokingChannelId] = {
        type: PersonaType.Preset,
        id: presetId,
      };

      const success = await configService.saveServerConfig(serverConfig);
      await interaction.editReply(
        success
          ? `Persona for ${channelLabel} set to: **${presetPersona.name}** (ID: ${presetId}).`
          : "Failed to save configuration.",
      );
      break;
    }
    case "list": {
      const availablePersonas = configService.getAvailablePresetPersonas();
      if (availablePersonas.size === 0) {
        await interaction.editReply("No preset personas are currently available.");
        return;
      }

      const personaLines = Array.from(availablePersonas.values()).map(
        (persona: PersonaDefinition) =>
          `• **${persona.name}** (ID: \`${persona.id}\`) - ${persona.description}`,
      );

      const channelPersonaRef =
        serverConfig.personaMappings[invokingChannelId] ??
        serverConfig.personaMappings["default"];

      let activePersonaMessage =
        `This ${contextNoun} is using the default persona configuration.`;

      if (channelPersonaRef) {
        if (channelPersonaRef.type === PersonaType.Preset) {
          const activePreset = configService.getPresetPersona(
            channelPersonaRef.id,
          );
          if (activePreset) {
            activePersonaMessage = `Active persona for this ${contextNoun}: **${activePreset.name}** (ID: \`${activePreset.id}\`).`;
          } else {
            activePersonaMessage = `Active persona for this ${contextNoun} references missing preset ID \`${channelPersonaRef.id}\`. Using fallback behaviour.`;
          }
        } else {
          activePersonaMessage = `Active persona for this ${contextNoun}: Custom persona \`${channelPersonaRef.id}\`.`;
        }
      }

      const maxMessageLength = 1900; // stay comfortably under Discord's 2000 char cap
      const allLines = [
        activePersonaMessage,
        "**Available Personas:**",
        ...personaLines,
      ];

      const chunks: string[] = [];
      let currentChunk = "";

      for (const line of allLines) {
        const safeLine = line ?? "";
        const nextChunk = currentChunk ? `${currentChunk}\n${safeLine}` : safeLine;

        if (nextChunk.length > maxMessageLength) {
          if (currentChunk) {
            chunks.push(currentChunk);
            currentChunk = safeLine;
            if (currentChunk.length > maxMessageLength) {
              chunks.push(`${currentChunk.slice(0, maxMessageLength - 3)}...`);
              currentChunk = "";
            }
          } else {
            chunks.push(`${safeLine.slice(0, maxMessageLength - 3)}...`);
            currentChunk = "";
          }
        } else {
          currentChunk = nextChunk;
        }
      }

      if (currentChunk) {
        chunks.push(currentChunk);
      }

      if (chunks.length === 0) {
        chunks.push(activePersonaMessage);
      }

      const [firstChunk, ...remainingChunks] = chunks;

      await interaction.editReply(firstChunk ?? activePersonaMessage);

      for (const chunk of remainingChunks) {
        await interaction.followUp(
          isDm
            ? { content: chunk }
            : { content: chunk, ephemeral: true as const },
        );
      }
      break;
    }
    default:
      await interaction.editReply("Invalid persona action specified.");
  }
}
