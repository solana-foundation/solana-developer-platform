import fs from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const DEV_VARS_PATH = path.resolve(__dirname, ".dev.vars");

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key) {
      continue;
    }

    vars[key] = rest.join("=");
  }

  return vars;
}

const fileEnv = loadEnvFile(DEV_VARS_PATH);
const getEnv = (key: string, fallback?: string) => process.env[key] ?? fileEnv[key] ?? fallback;

// biome-ignore lint/security/noSecrets: Local Docker Postgres fallback for isolated tests.
const TEST_DATABASE_URL_FALLBACK = "postgresql://sdp:sdp@127.0.0.1:5432/sdp_test";

// Keep this in sync with apps/sdp-api/scripts/migrate-postgres-test.mjs so vitest
// and `pnpm db:migrate:test` always agree on which database to use.
function deriveTestDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, "")) || "sdp";
  url.pathname = `/${encodeURIComponent(`${dbName}_test`)}`;
  return url.toString();
}

const explicitTestDatabaseUrl = getEnv("TEST_DATABASE_URL");
const baseDatabaseUrl = getEnv("DATABASE_URL");
const testDatabaseUrl =
  explicitTestDatabaseUrl ??
  (baseDatabaseUrl ? deriveTestDatabaseUrl(baseDatabaseUrl) : TEST_DATABASE_URL_FALLBACK);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
      },
      miniflare: {
        bindings: {
          ENVIRONMENT: "development",
          API_VERSION: "v1",
          API_KEY_PEPPER: "test-pepper-for-unit-tests",
          SOLANA_MOCK: "true",
          RUN_INTEGRATION_TESTS: "false",
        },
        hyperdrives: {
          HYPERDRIVE: testDatabaseUrl,
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@sdp/types": path.resolve(__dirname, "../../packages/sdp-types/src"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
    include: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/__tests__/**/*.unit.ts"],
    // `**\/*.node.test.ts` runs in vitest.node.config.ts (plain Node pool)
    // because ioredis needs Node socket APIs the Workers pool doesn't expose.
    exclude: ["node_modules", ".wrangler", "dist", "src/**/*.node.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/types/**", "src/db/migrations/**"],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
