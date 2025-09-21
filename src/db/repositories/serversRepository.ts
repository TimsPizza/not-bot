import { and, eq, inArray } from "drizzle-orm";
import type { LanguageConfig, PersonaRef, ServerConfig } from "@/types";
import { PersonaType, SupportedLanguage } from "@/types";
import { getDb } from "../client";
import {
  personaAssignments,
  personas,
  serverChannelPermissions,
  serverSummaryAllowedRoles,
  serverSummaryBannedChannels,
  servers,
} from "../schema";
import type { ServerRow } from "../schema";

type ServerInsert = typeof servers.$inferInsert;
type ServerUpdate = Partial<ServerInsert>;

const SERVER_DEFAULT_TARGET_ID = "__server_default__";

type AssignmentRow = {
  targetType: string;
  targetId: string;
  personaId: string;
  scope: string;
};

function toLanguageConfig(row: ServerRow): LanguageConfig {
  return {
    primary: (row.languagePrimary as SupportedLanguage) ?? SupportedLanguage.Auto,
    fallback: (row.languageFallback as SupportedLanguage) ?? SupportedLanguage.English,
    autoDetect: Boolean(row.languageAutoDetect ?? true),
  };
}

function toPersonaRef(scope: string, personaId: string): PersonaRef {
  return {
    type: scope === "builtin" ? PersonaType.Preset : PersonaType.Custom,
    id: personaId,
  };
}

function assemblePersonaMappings(rows: AssignmentRow[]): Record<string, PersonaRef> {
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

  const summarySettings = row.summaryEnabled
    ? {
        enabled: Boolean(row.summaryEnabled),
        maxMessagesPerSummary: row.summaryMaxMessages ?? 50,
        cooldownSeconds: row.summaryCooldownSeconds ?? 0,
        allowedRoles: summaryAllowedRoles,
        bannedChannels: summaryBannedChannels,
      }
    : summaryAllowedRoles.length || summaryBannedChannels.length
    ? {
        enabled: Boolean(row.summaryEnabled),
        maxMessagesPerSummary: row.summaryMaxMessages ?? 50,
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
    maxContextMessages: row.maxContextMessages ?? undefined,
    maxDailyResponses: row.maxDailyResponses ?? undefined,
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
  return {
    serverId: config.serverId,
    responsiveness: config.responsiveness,
    maxContextMessages: config.maxContextMessages ?? null,
    maxDailyResponses: config.maxDailyResponses ?? null,
    languagePrimary: config.languageConfig?.primary ?? SupportedLanguage.Auto,
    languageFallback: config.languageConfig?.fallback ?? SupportedLanguage.English,
    languageAutoDetect: config.languageConfig?.autoDetect ?? true,
    channelMode: config.channelConfig?.mode ?? "whitelist",
    channelAutoManage: config.channelConfig?.autoManage ?? false,
    summaryEnabled: config.summarySettings?.enabled ?? false,
    summaryMaxMessages: config.summarySettings?.maxMessagesPerSummary ?? null,
    summaryCooldownSeconds: config.summarySettings?.cooldownSeconds ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildServerUpdate(config: ServerConfig, now: number): ServerUpdate {
  return {
    responsiveness: config.responsiveness,
    maxContextMessages: config.maxContextMessages ?? null,
    maxDailyResponses: config.maxDailyResponses ?? null,
    languagePrimary: config.languageConfig?.primary ?? SupportedLanguage.Auto,
    languageFallback: config.languageConfig?.fallback ?? SupportedLanguage.English,
    languageAutoDetect: config.languageConfig?.autoDetect ?? true,
    channelMode: config.channelConfig?.mode ?? "whitelist",
    channelAutoManage: config.channelConfig?.autoManage ?? false,
    summaryEnabled: config.summarySettings?.enabled ?? false,
    summaryMaxMessages: config.summarySettings?.maxMessagesPerSummary ?? null,
    summaryCooldownSeconds: config.summarySettings?.cooldownSeconds ?? null,
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
    tx
      .insert(servers)
      .values(buildServerInsert(config, now))
      .onConflictDoUpdate({
        target: servers.serverId,
        set: buildServerUpdate(config, now),
      })
      .run();

    tx
      .delete(serverChannelPermissions)
      .where(eq(serverChannelPermissions.serverId, config.serverId))
      .run();
    if (allowedChannels.length) {
      tx
        .insert(serverChannelPermissions)
        .values(
          allowedChannels.map((channelId) => ({
            serverId: config.serverId,
            channelId,
          })),
        )
        .run();
    }

    tx
      .delete(serverSummaryAllowedRoles)
      .where(eq(serverSummaryAllowedRoles.serverId, config.serverId))
      .run();
    if (summaryAllowedRoles.length) {
      tx
        .insert(serverSummaryAllowedRoles)
        .values(
          summaryAllowedRoles.map((roleId) => ({
            serverId: config.serverId,
            roleId,
          })),
        )
        .run();
    }

    tx
      .delete(serverSummaryBannedChannels)
      .where(eq(serverSummaryBannedChannels.serverId, config.serverId))
      .run();
    if (summaryBannedChannels.length) {
      tx
        .insert(serverSummaryBannedChannels)
        .values(
          summaryBannedChannels.map((channelId) => ({
            serverId: config.serverId,
            channelId,
          })),
        )
        .run();
    }

    tx
      .delete(personaAssignments)
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
    languageConfig: {
      primary: SupportedLanguage.Auto,
      fallback: SupportedLanguage.English,
      autoDetect: true,
    },
    summarySettings: {
      enabled: false,
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
