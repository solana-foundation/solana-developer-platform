import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { getE2EEnv } from "./playwright/env";

const env = getE2EEnv();
const authStatePath = path.join(__dirname, "playwright/.clerk/user.json");
const fixturesPath = path.join(__dirname, "playwright/.fixtures/issuance.json");
const localApiPort = process.env.PLAYWRIGHT_API_PORT ?? "8788";
const localApiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${localApiPort}`;
const apiPersistPath = process.env.PLAYWRIGHT_API_PERSIST_PATH ?? ".wrangler/state-playwright";
const webPort = new URL(env.baseURL).port || "3001";
const nextDistDir = process.env.PLAYWRIGHT_NEXT_DIST_DIR ?? ".next-playwright";

function resolveProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export default defineConfig({
  testDir: "./playwright/tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: env.baseURL,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "node scripts/dev-local.mjs",
      cwd: path.join(__dirname, "../sdp-api"),
      url: `${localApiUrl}/health`,
      reuseExistingServer: false,
      env: {
        ...resolveProcessEnv(),
        SDP_API_LOCAL_PERSIST_PATH: apiPersistPath,
        SDP_API_PORT: localApiPort,
        SDP_API_RESET_LOCAL_STATE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
    {
      command: `pnpm exec next dev --hostname localhost --port ${webPort}`,
      cwd: __dirname,
      url: env.baseURL,
      reuseExistingServer: false,
      env: {
        ...resolveProcessEnv(),
        ...env.webServerEnv,
        PLAYWRIGHT_NEXT_DIST_DIR: nextDistDir,
        SDP_API_BASE_URL: localApiUrl,
        NEXT_PUBLIC_SDP_API_BASE_URL: localApiUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
  ],
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\.global\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "issuance",
      testMatch: /.*issuance.*\.spec\.ts/,
      dependencies: ["auth-setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
      },
    },
  ],
  outputDir: path.join(__dirname, "test-results"),
  metadata: {
    authStatePath,
    fixturesPath,
    localApiUrl,
  },
});
