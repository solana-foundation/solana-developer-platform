import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { getE2EEnv } from "./playwright/env";

const env = getE2EEnv();
const authStatePath = path.join(__dirname, "playwright/.clerk/user.json");

function resolveProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export default defineConfig({
  testDir: "./playwright/tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: env.baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm exec next dev --hostname localhost --port 3000",
    cwd: __dirname,
    url: env.baseURL,
    reuseExistingServer: !process.env.CI,
    env: {
      ...resolveProcessEnv(),
      ...env.webServerEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\.global\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "smoke",
      testMatch: /.*\.smoke\.spec\.ts/,
      dependencies: ["auth-setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: authStatePath,
      },
    },
  ],
});
