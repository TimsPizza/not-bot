export { initializeDatabase as initializeDataStore, getDb } from "./client";

export {
  getServerConfig,
  upsertServerConfig,
  ensureServerConfig,
} from "./repositories/serversRepository";

export {
  upsertChannel,
  updateChannelStateAfterMessages,
  getChannelState,
} from "./repositories/channelsRepository";

export {
  persistMessages,
  getRecentMessages,
  markMessageResponded,
} from "./repositories/messagesRepository";

export {
  upsertPersona,
  getPersonaById,
  listBuiltInPersonas,
  listCustomPersonas,
  deleteCustomPersona,
  bulkUpsertBuiltins,
} from "./repositories/personasRepository";
