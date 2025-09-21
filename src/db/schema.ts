import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const servers = sqliteTable("servers", {
  serverId: text("server_id").primaryKey(),
  responsiveness: integer("responsiveness", { mode: "number" })
    .notNull()
    .default(1),
  languagePrimary: text("language_primary").notNull().default("auto"),
  languageFallback: text("language_fallback").notNull().default("en"),
  languageAutoDetect: integer("language_auto_detect", { mode: "boolean" })
    .notNull()
    .default(true),
  maxContextMessages: integer("max_context_messages", { mode: "number" }),
  maxDailyResponses: integer("max_daily_responses", { mode: "number" }),
  channelMode: text("channel_mode").notNull().default("whitelist"),
  channelAutoManage: integer("channel_auto_manage", { mode: "boolean" })
    .notNull()
    .default(false),
  summaryEnabled: integer("summary_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  summaryMaxMessages: integer("summary_max_messages", { mode: "number" }),
  summaryCooldownSeconds: integer("summary_cooldown_seconds", {
    mode: "number",
  }),
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
});

export const channels = sqliteTable("channels", {
  channelId: text("channel_id").primaryKey(),
  serverId: text("server_id"),
  type: text("type").notNull(),
  ownerUserId: text("owner_user_id"),
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
});

export const channelState = sqliteTable("channel_state", {
  channelId: text("channel_id").primaryKey(),
  messageCount: integer("message_count", { mode: "number" })
    .notNull()
    .default(0),
  lastMessageTimestamp: integer("last_message_timestamp", { mode: "number" }),
  lastProcessedMessageId: text("last_processed_message_id"),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`),
});

export const channelMessages = sqliteTable(
  "channel_messages",
  {
    messageId: text("message_id").primaryKey(),
    channelId: text("channel_id").notNull(),
    serverId: text("server_id"),
    authorId: text("author_id").notNull(),
    authorUsername: text("author_username"),
    content: text("content").notNull(),
    timestamp: integer("timestamp", { mode: "number" }).notNull(),
    isBot: integer("is_bot", { mode: "boolean" })
      .notNull()
      .default(false),
    mentionsEveryone: integer("mentions_everyone", { mode: "boolean" })
      .notNull()
      .default(false),
    hasAttachments: integer("has_attachments", { mode: "boolean" })
      .notNull()
      .default(false),
    hasEmbeds: integer("has_embeds", { mode: "boolean" })
      .notNull()
      .default(false),
    respondedTo: integer("responded_to", { mode: "boolean" })
      .notNull()
      .default(false),
    hasBeenRepliedTo: integer("has_been_replied_to", { mode: "boolean" })
      .notNull()
      .default(false),
    referenceMessageId: text("reference_message_id"),
    referenceChannelId: text("reference_channel_id"),
    referenceGuildId: text("reference_guild_id"),
  },
  (table) => ({
    channelIdx: index("channel_messages_channel_idx").on(table.channelId),
    channelTimestampIdx: index("channel_messages_channel_timestamp_idx").on(
      table.channelId,
      table.timestamp,
    ),
  }),
);

export const messageUserMentions = sqliteTable(
  "message_user_mentions",
  {
    messageId: text("message_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.userId] }),
    messageIdx: index("message_user_mentions_message_idx").on(table.messageId),
  }),
);

export const messageRoleMentions = sqliteTable(
  "message_role_mentions",
  {
    messageId: text("message_id").notNull(),
    roleId: text("role_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.roleId] }),
    messageIdx: index("message_role_mentions_message_idx").on(table.messageId),
  }),
);

export const serverChannelPermissions = sqliteTable(
  "server_channel_permissions",
  {
    serverId: text("server_id").notNull(),
    channelId: text("channel_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.channelId] }),
    serverIdx: index("server_channel_permissions_server_idx").on(table.serverId),
  }),
);

export const serverSummaryAllowedRoles = sqliteTable(
  "server_summary_allowed_roles",
  {
    serverId: text("server_id").notNull(),
    roleId: text("role_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.roleId] }),
    serverIdx: index("server_summary_allowed_roles_server_idx").on(
      table.serverId,
    ),
  }),
);

export const serverSummaryBannedChannels = sqliteTable(
  "server_summary_banned_channels",
  {
    serverId: text("server_id").notNull(),
    channelId: text("channel_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.channelId] }),
    serverIdx: index("server_summary_banned_channels_server_idx").on(
      table.serverId,
    ),
  }),
);

export const personas = sqliteTable(
  "personas",
  {
    personaId: text("persona_id").primaryKey(),
    scope: text("scope").notNull(),
    serverId: text("server_id"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    details: text("details").notNull(),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .default(sql`(strftime('%s','now') * 1000)`),
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .default(sql`(strftime('%s','now') * 1000)`),
  },
  (table) => ({
    serverIdx: index("personas_server_idx").on(table.serverId),
    scopeIdx: index("personas_scope_idx").on(table.scope),
  }),
);

export const personaAssignments = sqliteTable(
  "persona_assignments",
  {
    assignmentId: integer("assignment_id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    personaId: text("persona_id").notNull(),
    priority: integer("priority", { mode: "number" }).notNull().default(0),
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .default(sql`(strftime('%s','now') * 1000)`),
  },
  (table) => ({
    serverTargetUnique: uniqueIndex("persona_assignments_server_target_uid").on(
      table.serverId,
      table.targetType,
      table.targetId,
    ),
    personaIdx: index("persona_assignments_persona_idx").on(table.personaId),
  }),
);

export type ServerRow = typeof servers.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ChannelStateRow = typeof channelState.$inferSelect;
export type ChannelMessageRow = typeof channelMessages.$inferSelect;
export type PersonaRow = typeof personas.$inferSelect;
