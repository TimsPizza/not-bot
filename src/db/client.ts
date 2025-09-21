import path from "path";
import fsExtra from "fs-extra";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import loggerService from "@/logger";

let sqliteInstance: Database.Database | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;
let currentDbFile: string | null = null;

export function initializeDatabase(serverDataPath: string): BetterSQLite3Database<typeof schema> {
  if (dbInstance && currentDbFile) {
    return dbInstance;
  }

  fsExtra.ensureDirSync(serverDataPath);
  const dbFilePath = path.join(serverDataPath, "bot-data.sqlite");

  sqliteInstance = new Database(dbFilePath);
  sqliteInstance.pragma("journal_mode = WAL");
  sqliteInstance.pragma("foreign_keys = ON");

  dbInstance = drizzle(sqliteInstance, { schema });
  currentDbFile = dbFilePath;

  try {
    migrate(dbInstance, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } catch (error) {
    loggerService.logger.error({ err: error }, "Failed to run SQLite migrations");
    throw error;
  }

  loggerService.logger.info(`SQLite database ready at ${dbFilePath}`);
  return dbInstance;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!dbInstance) {
    throw new Error("Database has not been initialized. Call initializeDatabase first.");
  }
  return dbInstance;
}

export function getSqliteInstance(): Database.Database {
  if (!sqliteInstance) {
    throw new Error("Database has not been initialized. Call initializeDatabase first.");
  }
  return sqliteInstance;
}

export function closeDatabase(): void {
  if (sqliteInstance) {
    sqliteInstance.close();
  }
  sqliteInstance = null;
  dbInstance = null;
  currentDbFile = null;
}
