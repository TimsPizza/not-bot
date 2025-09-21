import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./server_data/bot-data.sqlite",
  },
});
