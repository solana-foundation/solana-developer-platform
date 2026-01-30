import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/drizzle/schema/sqlite.ts",
  out: "./src/db/drizzle/migrations",
  driver: "d1",
  dialect: "sqlite",
  dbCredentials: {
    wranglerConfigPath: "./wrangler.toml",
    dbName: "sdp-db",
  },
});
