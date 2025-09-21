import path from "path";
import fsExtra from "fs-extra";
import Database from "better-sqlite3";
import QuickLRU from "quick-lru";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import loggerService from "@/logger";
import type {
  ServerConfig,
  ChannelContext,
  PersonaDefinition,
} from "@/types";
import {
  serverConfigs,
  channelContexts,
  customPersonas,
} from "./schema";

function clone<T>(value: T): T {
  return value ? (JSON.parse(JSON.stringify(value)) as T) : value;
}

function personaCacheKey(serverId: string, personaId: string): string {
  return `${serverId}::${personaId}`;
}

class SqliteDataStore {
  private sqlite: Database.Database;
  private db: BetterSQLite3Database;
  private serverConfigCache = new QuickLRU<string, ServerConfig>({ maxSize: 200 });
  private channelContextCache = new QuickLRU<string, ChannelContext>({
    maxSize: 500,
  });
  private personaCache = new QuickLRU<string, PersonaDefinition>({ maxSize: 500 });

  constructor(dbFilePath: string) {
    this.sqlite = new Database(dbFilePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite);
  }

  public initialize(): void {
    const migrationsPath = path.join(process.cwd(), "drizzle");
    try {
      migrate(this.db, { migrationsFolder: migrationsPath });
    } catch (error) {
      loggerService.logger.error(
        { err: error, migrationsPath },
        "Failed to run database migrations",
      );
      throw error;
    }
  }

  // --- Server Configs ---

  public getServerConfig(serverId: string): ServerConfig | null {
    const cached = this.serverConfigCache.get(serverId);
    if (cached) {
      return clone(cached);
    }

    const row = this.db
      .select({
        configJson: serverConfigs.configJson,
      })
      .from(serverConfigs)
      .where(eq(serverConfigs.serverId, serverId))
      .get();

    if (!row) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.configJson) as ServerConfig;
      this.serverConfigCache.set(serverId, parsed);
      return clone(parsed);
    } catch (error) {
      loggerService.logger.error(
        { err: error, serverId },
        "Failed to parse server config JSON from SQLite",
      );
      return null;
    }
  }

  public setServerConfig(config: ServerConfig): void {
    const now = Date.now();
    this.db
      .insert(serverConfigs)
      .values({
        serverId: config.serverId,
        configJson: JSON.stringify(config),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: serverConfigs.serverId,
        set: {
          configJson: JSON.stringify(config),
          updatedAt: now,
        },
      })
      .run();

    this.serverConfigCache.set(config.serverId, clone(config));
  }

  // --- Channel Contexts ---

  public getChannelContext(channelId: string): ChannelContext | null {
    const cached = this.channelContextCache.get(channelId);
    if (cached) {
      return clone(cached);
    }

    const row = this.db
      .select({
        contextJson: channelContexts.contextJson,
      })
      .from(channelContexts)
      .where(eq(channelContexts.channelId, channelId))
      .get();

    if (!row) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.contextJson) as ChannelContext;
      this.channelContextCache.set(channelId, parsed);
      return clone(parsed);
    } catch (error) {
      loggerService.logger.error(
        { err: error, channelId },
        "Failed to parse channel context JSON",
      );
      return null;
    }
  }

  public setChannelContext(context: ChannelContext): void {
    const now = Date.now();
    this.db
      .insert(channelContexts)
      .values({
        channelId: context.channelId,
        serverId: context.serverId,
        contextJson: JSON.stringify(context),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: channelContexts.channelId,
        set: {
          serverId: context.serverId,
          contextJson: JSON.stringify(context),
          updatedAt: now,
        },
      })
      .run();

    this.channelContextCache.set(context.channelId, clone(context));
  }

  public deleteChannelContext(channelId: string): void {
    this.db
      .delete(channelContexts)
      .where(eq(channelContexts.channelId, channelId))
      .run();
    this.channelContextCache.delete(channelId);
  }

  // --- Custom Personas ---

  public getCustomPersona(
    serverId: string,
    personaId: string,
  ): PersonaDefinition | null {
    const key = personaCacheKey(serverId, personaId);
    const cached = this.personaCache.get(key);
    if (cached) {
      return clone(cached);
    }

    const row = this.db
      .select({
        name: customPersonas.name,
        description: customPersonas.description,
        details: customPersonas.details,
      })
      .from(customPersonas)
      .where(
        and(
          eq(customPersonas.serverId, serverId),
          eq(customPersonas.personaId, personaId),
        ),
      )
      .get();

    if (!row) {
      return null;
    }

    const persona: PersonaDefinition = {
      id: personaId,
      name: row.name,
      description: row.description,
      details: row.details,
    };
    this.personaCache.set(key, persona);
    return clone(persona);
  }

  public upsertCustomPersona(
    serverId: string,
    persona: PersonaDefinition,
  ): void {
    const now = Date.now();
    this.db
      .insert(customPersonas)
      .values({
        serverId,
        personaId: persona.id,
        name: persona.name,
        description: persona.description,
        details: persona.details,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [customPersonas.serverId, customPersonas.personaId],
        set: {
          name: persona.name,
          description: persona.description,
          details: persona.details,
          updatedAt: now,
        },
      })
      .run();

    const key = personaCacheKey(serverId, persona.id);
    this.personaCache.set(key, clone(persona));
  }

  public deleteCustomPersona(serverId: string, personaId: string): void {
    this.db
      .delete(customPersonas)
      .where(
        and(
          eq(customPersonas.serverId, serverId),
          eq(customPersonas.personaId, personaId),
        ),
      )
      .run();
    const key = personaCacheKey(serverId, personaId);
    this.personaCache.delete(key);
  }

  public listCustomPersonas(serverId: string): PersonaDefinition[] {
    const rows = this.db
      .select({
        personaId: customPersonas.personaId,
        name: customPersonas.name,
        description: customPersonas.description,
        details: customPersonas.details,
      })
      .from(customPersonas)
      .where(eq(customPersonas.serverId, serverId))
      .all();

    return rows.map((row) => {
      const persona: PersonaDefinition = {
        id: row.personaId,
        name: row.name,
        description: row.description,
        details: row.details,
      };
      const key = personaCacheKey(serverId, row.personaId);
      this.personaCache.set(key, clone(persona));
      return clone(persona);
    });
  }
}

let instance: SqliteDataStore | null = null;

export function initializeDataStore(serverDataPath: string): SqliteDataStore {
  if (instance) {
    return instance;
  }

  fsExtra.ensureDirSync(serverDataPath);
  const dbFilePath = path.join(serverDataPath, "bot-data.sqlite");
  const dataStore = new SqliteDataStore(dbFilePath);
  dataStore.initialize();
  instance = dataStore;
  loggerService.logger.info(`SQLite data store ready at ${dbFilePath}`);
  return instance;
}

export function getDataStore(): SqliteDataStore {
  if (!instance) {
    throw new Error("SqliteDataStore has not been initialized.");
  }
  return instance;
}
