#!/usr/bin/env node
import configService from "@/config";
import { getDataStore, initializeDataStore } from "@/db/datastore";
import loggerService from "@/logger";
import type { ChannelContext, PersonaDefinition, ServerConfig } from "@/types";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";

async function migrateServerConfigFiles(
  serverDataPath: string,
  serverId: string,
): Promise<void> {
  const configFilePath = path.join(serverDataPath, serverId, "config.json");
  if (!(await fs.pathExists(configFilePath))) {
    return;
  }

  try {
    const fileContent = await fs.readFile(configFilePath, "utf-8");
    const parsed = JSON.parse(fileContent) as Partial<ServerConfig>;

    if (!parsed || typeof parsed !== "object") {
      loggerService.logger.warn(
        `Skipping invalid server config JSON for ${serverId} at ${configFilePath}.`,
      );
      return;
    }

    const defaults = configService.getServerConfig(serverId);
    const merged: ServerConfig = {
      ...defaults,
      ...parsed,
      serverId,
      personaMappings:
        parsed.personaMappings && Object.keys(parsed.personaMappings).length > 0
          ? parsed.personaMappings
          : defaults.personaMappings,
    };

    getDataStore().setServerConfig(merged);
    loggerService.logger.info(
      `Migrated server config for ${serverId} into SQLite data store.`,
    );
  } catch (error) {
    loggerService.logger.error(
      `Failed to migrate server config for ${serverId} at ${configFilePath}:`,
    );
  }
}

async function migrateChannelContexts(
  serverDataPath: string,
  serverId: string,
): Promise<void> {
  const contextDir = path.join(serverDataPath, serverId, "context");
  if (!(await fs.pathExists(contextDir))) {
    return;
  }

  const files = await fs.readdir(contextDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const channelId = path.basename(file, ".json");
    const filePath = path.join(contextDir, file);

    try {
      const fileContent = await fs.readFile(filePath, "utf-8");
      const context = JSON.parse(fileContent) as ChannelContext;
      if (!context || !Array.isArray(context.messages)) {
        loggerService.logger.warn(`Skipping invalid context file ${filePath}.`);
        continue;
      }

      context.serverId = context.serverId ?? serverId;
      getDataStore().setChannelContext(context);
      loggerService.logger.info(
        `Migrated context for channel ${channelId} (server ${serverId}).`,
      );
    } catch (error) {
      loggerService.logger.error(
        `Failed to migrate context file ${filePath}: ${error}`,
      );
    }
  }
}

async function migrateCustomPersonas(
  serverDataPath: string,
  serverId: string,
): Promise<void> {
  const personasDir = path.join(serverDataPath, serverId, "personas");
  if (!(await fs.pathExists(personasDir))) {
    return;
  }

  const files = await fs.readdir(personasDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const personaId = path.basename(file, ".json");
    const filePath = path.join(personasDir, file);

    try {
      const fileContent = await fs.readFile(filePath, "utf-8");
      const persona = JSON.parse(fileContent) as PersonaDefinition;
      if (!persona || !persona.name || !persona.details) {
        loggerService.logger.warn(`Skipping invalid persona file ${filePath}.`);
        continue;
      }

      persona.id = personaId;
      getDataStore().upsertCustomPersona(serverId, persona);
      loggerService.logger.info(
        `Migrated custom persona '${personaId}' for server ${serverId}.`,
      );
    } catch (error) {
      loggerService.logger.error(
        `Failed to migrate persona file ${filePath}: ${error}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const config = configService.getConfig();
  const serverDataPath = config.serverDataPath;
  if (!serverDataPath) {
    loggerService.logger.error(
      "SERVER_DATA_PATH is not defined. Nothing to migrate.",
    );
    return;
  }

  initializeDataStore(serverDataPath);

  if (!(await fs.pathExists(serverDataPath))) {
    loggerService.logger.info(
      `Server data path ${serverDataPath} does not exist. Nothing to migrate.`,
    );
    return;
  }

  const entries = await fs.readdir(serverDataPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const serverId = entry.name;
    await migrateServerConfigFiles(serverDataPath, serverId);
    await migrateChannelContexts(serverDataPath, serverId);
    await migrateCustomPersonas(serverDataPath, serverId);
  }

  loggerService.logger.info("Legacy JSON migration complete.");
}

main().catch((error) => {
  loggerService.logger.error({ err: error }, "Legacy migration failed");
  process.exitCode = 1;
});
