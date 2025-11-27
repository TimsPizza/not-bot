import type { LanguageConfig, PersonaRef, ServerConfig } from "@/types";
import { PersonaType, SupportedLanguage } from "@/types";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import type { ServerRow } from "../schema";
import {
  personaAssignments,
  personas,
  serverChannelPermissions,
  serverSummaryAllowedRoles,
  serverSummaryBannedChannels,
  servers,
} from "../schema";

type ServerInsert = typeof servers.$inferInsert;
type ServerUpdate = Partial<ServerInsert>;

const SERVER_DEFAULT_TARGET_ID = "__server_default__";
const MIN_COMPLETION_DELAY = 3;
const MAX_COMPLETION_DELAY = 120;
const MAX_CONTEXT_MESSAGES = 200;
const MIN_CONTEXT_MESSAGES = 1;

function clampCompletionDelay(value?: number | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return MIN_COMPLETION_DELAY;
  }
  return Math.min(MAX_COMPLETION_DELAY, Math.max(MIN_COMPLETION_DELAY, value));
}

function normalizeContextLimit(value?: number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Number.isNaN(value)) {
    return null;
  }
  const clamped = Math.min(
    MAX_CONTEXT_MESSAGES,
    Math.max(MIN_CONTEXT_MESSAGES, value),
  );
  return clamped;
}

type AssignmentRow = {
  targetType: string;
  targetId: string;
  personaId: string;
  scope: string;
};

function toLanguageConfig(row: ServerRow): LanguageConfig {
  return {
    primary:
      (row.languagePrimary as SupportedLanguage) ?? SupportedLanguage.Auto,
    fallback:
      (row.languageFallback as SupportedLanguage) ?? SupportedLanguage.English,
    autoDetect: Boolean(row.languageAutoDetect ?? true),
  };
}

function toPersonaRef(scope: string, personaId: string): PersonaRef {
  return {
    type: scope === "builtin" ? PersonaType.Preset : PersonaType.Custom,
    id: personaId,
  };
}

function assemblePersonaMappings(
  rows: AssignmentRow[],
): Record<string, PersonaRef> {
  if (!rows.length) {
    return {
      default: {
        type: PersonaType.Preset,
        id: "default",
      },
    };
  }

  const result: Record<string, PersonaRef> = {};
  for (const row of rows) {
    const ref = toPersonaRef(row.scope, row.personaId);
    if (row.targetType === "server_default") {
      result.default = ref;
    } else if (row.targetType === "channel") {
      result[row.targetId] = ref;
    }
  }

  if (!result.default) {
    result.default = {
      type: PersonaType.Preset,
      id: "default",
    };
  }

  return result;
}

function buildDomainConfig(
  row: ServerRow,
  personaRows: AssignmentRow[],
  allowedChannels: string[],
  summaryAllowedRoles: string[],
  summaryBannedChannels: string[],
): ServerConfig {
  const languageConfig = toLanguageConfig(row);
  const personaMappings = assemblePersonaMappings(personaRows);
  const maxContextMessages =
    row.maxContextMessages === null || row.maxContextMessages === undefined
      ? undefined
      : (normalizeContextLimit(row.maxContextMessages) ?? undefined);

  const summarySettings = row.summaryEnabled
    ? {
        enabled: Boolean(row.summaryEnabled),
        maxMessagesPerSummary: row.summaryMaxMessages ?? 200,
        cooldownSeconds: row.summaryCooldownSeconds ?? 0,
        allowedRoles: summaryAllowedRoles,
        bannedChannels: summaryBannedChannels,
      }
    : summaryAllowedRoles.length || summaryBannedChannels.length
      ? {
          enabled: Boolean(row.summaryEnabled),
          maxMessagesPerSummary: row.summaryMaxMessages ?? 200,
          cooldownSeconds: row.summaryCooldownSeconds ?? 0,
          allowedRoles: summaryAllowedRoles,
          bannedChannels: summaryBannedChannels,
        }
      : undefined;

  return {
    serverId: row.serverId,
    responsiveness: row.responsiveness ?? 1,
    allowedChannels: allowedChannels.length ? allowedChannels : null,
    personaMappings,
    maxContextMessages,
    maxDailyResponses: row.maxDailyResponses ?? undefined,
    completionDelaySeconds: clampCompletionDelay(row.completionDelaySeconds),
    languageConfig,
    summarySettings,
    channelConfig: {
      allowedChannels,
      mode: (row.channelMode as "whitelist" | "blacklist") ?? "whitelist",
      autoManage: Boolean(row.channelAutoManage ?? false),
    },
  };
}

export function getServerConfig(serverId: string): ServerConfig | null {
  const db = getDb();

  const serverRow = db
    .select()
    .from(servers)
    .where(eq(servers.serverId, serverId))
    .get();

  if (!serverRow) {
    return null;
  }

  const allowedChannels = db
    .select({ channelId: serverChannelPermissions.channelId })
    .from(serverChannelPermissions)
    .where(eq(serverChannelPermissions.serverId, serverId))
    .all()
    .map((row) => row.channelId);

  const summaryAllowedRoles = db
    .select({ roleId: serverSummaryAllowedRoles.roleId })
    .from(serverSummaryAllowedRoles)
    .where(eq(serverSummaryAllowedRoles.serverId, serverId))
    .all()
    .map((row) => row.roleId);

  const summaryBannedChannels = db
    .select({ channelId: serverSummaryBannedChannels.channelId })
    .from(serverSummaryBannedChannels)
    .where(eq(serverSummaryBannedChannels.serverId, serverId))
    .all()
    .map((row) => row.channelId);

  const personaRows = db
    .select({
      targetType: personaAssignments.targetType,
      targetId: personaAssignments.targetId,
      personaId: personaAssignments.personaId,
      scope: personas.scope,
    })
    .from(personaAssignments)
    .innerJoin(personas, eq(personaAssignments.personaId, personas.personaId))
    .where(eq(personaAssignments.serverId, serverId))
    .all();

  return buildDomainConfig(
    serverRow,
    personaRows,
    allowedChannels,
    summaryAllowedRoles,
    summaryBannedChannels,
  );
}

function buildServerInsert(config: ServerConfig, now: number): ServerInsert {
  const contextLimit = normalizeContextLimit(config.maxContextMessages ?? null);
  return {
    serverId: config.serverId,
    responsiveness: config.responsiveness,
    maxContextMessages: contextLimit,
    maxDailyResponses: config.maxDailyResponses ?? null,
    languagePrimary: config.languageConfig?.primary ?? SupportedLanguage.Auto,
    languageFallback:
      config.languageConfig?.fallback ?? SupportedLanguage.English,
    languageAutoDetect: config.languageConfig?.autoDetect ?? true,
    channelMode: config.channelConfig?.mode ?? "whitelist",
    channelAutoManage: config.channelConfig?.autoManage ?? false,
    summaryEnabled: config.summarySettings?.enabled ?? false,
    summaryMaxMessages: config.summarySettings?.maxMessagesPerSummary ?? null,
    summaryCooldownSeconds: config.summarySettings?.cooldownSeconds ?? null,
    completionDelaySeconds: clampCompletionDelay(config.completionDelaySeconds),
    createdAt: now,
    updatedAt: now,
  };
}

function buildServerUpdate(config: ServerConfig, now: number): ServerUpdate {
  const contextLimit = normalizeContextLimit(config.maxContextMessages ?? null);
  return {
    responsiveness: config.responsiveness,
    maxContextMessages: contextLimit,
    maxDailyResponses: config.maxDailyResponses ?? null,
    languagePrimary: config.languageConfig?.primary ?? SupportedLanguage.Auto,
    languageFallback:
      config.languageConfig?.fallback ?? SupportedLanguage.English,
    languageAutoDetect: config.languageConfig?.autoDetect ?? true,
    channelMode: config.channelConfig?.mode ?? "whitelist",
    channelAutoManage: config.channelConfig?.autoManage ?? false,
    summaryEnabled: config.summarySettings?.enabled ?? false,
    summaryMaxMessages: config.summarySettings?.maxMessagesPerSummary ?? null,
    summaryCooldownSeconds: config.summarySettings?.cooldownSeconds ?? null,
    completionDelaySeconds: clampCompletionDelay(config.completionDelaySeconds),
    updatedAt: now,
  };
}

function personaEntriesFromConfig(config: ServerConfig) {
  const entries = Object.entries(
    config.personaMappings && Object.keys(config.personaMappings).length
      ? config.personaMappings
      : {
          default: {
            type: PersonaType.Preset,
            id: "default",
          },
        },
  );

  return entries.map(([target, ref]) => ({
    serverId: config.serverId,
    targetType: target === "default" ? "server_default" : "channel",
    targetId: target === "default" ? SERVER_DEFAULT_TARGET_ID : target,
    personaId: ref.id,
    priority: target === "default" ? 0 : 1,
    updatedAt: Date.now(),
  }));
}

export function upsertServerConfig(config: ServerConfig): void {
  const db = getDb();
  const allowedChannels = config.allowedChannels ?? [];
  const summaryAllowedRoles = config.summarySettings?.allowedRoles ?? [];
  const summaryBannedChannels = config.summarySettings?.bannedChannels ?? [];
  const personaEntries = personaEntriesFromConfig(config);
  const now = Date.now();

  db.transaction((tx) => {
    tx.insert(servers)
      .values(buildServerInsert(config, now))
      .onConflictDoUpdate({
        target: servers.serverId,
        set: buildServerUpdate(config, now),
      })
      .run();

    tx.delete(serverChannelPermissions)
      .where(eq(serverChannelPermissions.serverId, config.serverId))
      .run();
    if (allowedChannels.length) {
      tx.insert(serverChannelPermissions)
        .values(
          allowedChannels.map((channelId) => ({
            serverId: config.serverId,
            channelId,
          })),
        )
        .run();
    }

    tx.delete(serverSummaryAllowedRoles)
      .where(eq(serverSummaryAllowedRoles.serverId, config.serverId))
      .run();
    if (summaryAllowedRoles.length) {
      tx.insert(serverSummaryAllowedRoles)
        .values(
          summaryAllowedRoles.map((roleId) => ({
            serverId: config.serverId,
            roleId,
          })),
        )
        .run();
    }

    tx.delete(serverSummaryBannedChannels)
      .where(eq(serverSummaryBannedChannels.serverId, config.serverId))
      .run();
    if (summaryBannedChannels.length) {
      tx.insert(serverSummaryBannedChannels)
        .values(
          summaryBannedChannels.map((channelId) => ({
            serverId: config.serverId,
            channelId,
          })),
        )
        .run();
    }

    tx.delete(personaAssignments)
      .where(
        and(
          eq(personaAssignments.serverId, config.serverId),
          inArray(personaAssignments.targetType, ["server_default", "channel"]),
        ),
      )
      .run();

    if (personaEntries.length) {
      tx.insert(personaAssignments).values(personaEntries).run();
    }
  });
}

export function ensureServerConfig(serverId: string): ServerConfig {
  const existing = getServerConfig(serverId);
  if (existing) {
    return existing;
  }

  const defaultConfig: ServerConfig = {
    serverId,
    responsiveness: 1,
    allowedChannels: null,
    personaMappings: {
      default: {
        type: PersonaType.Preset,
        id: "default",
      },
    },
    completionDelaySeconds: MIN_COMPLETION_DELAY,
    languageConfig: {
      primary: SupportedLanguage.Auto,
      fallback: SupportedLanguage.English,
      autoDetect: true,
    },
    summarySettings: {
      enabled: true,
      maxMessagesPerSummary: 50,
      cooldownSeconds: 0,
      allowedRoles: [],
      bannedChannels: [],
    },
    channelConfig: {
      allowedChannels: [],
      mode: "whitelist",
      autoManage: false,
    },
  };

  upsertServerConfig(defaultConfig);
  return defaultConfig;
}
