import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const serverConfigs = sqliteTable("server_configs", {
  serverId: text("server_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const channelContexts = sqliteTable("channel_contexts", {
  channelId: text("channel_id").primaryKey(),
  serverId: text("server_id").notNull(),
  contextJson: text("context_json").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const customPersonas = sqliteTable(
  "custom_personas",
  {
    serverId: text("server_id").notNull(),
    personaId: text("persona_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    details: text("details").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.personaId] })],
);

export type ServerConfigRow = typeof serverConfigs.$inferSelect;
export type ChannelContextRow = typeof channelContexts.$inferSelect;
export type CustomPersonaRow = typeof customPersonas.$inferSelect;
