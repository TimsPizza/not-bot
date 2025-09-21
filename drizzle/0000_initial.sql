CREATE TABLE IF NOT EXISTS server_configs (
  server_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_contexts (
  channel_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_personas (
  server_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  details TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, persona_id)
);
