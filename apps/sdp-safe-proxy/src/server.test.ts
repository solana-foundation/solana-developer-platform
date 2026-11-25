import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "@sdp/metadata-server/caller";

// Every text value carries k4w, so stderr must never carry k4w.
const API_CALLER = "api-k4w@sdp-test.iam.gserviceaccount.com";
const CLOUD_RUN = {
  K_SERVICE: "sdp-safe-proxy",
  PORT: "48791",
  SAFE_PROXY_PROVIDER_TIMEOUT_MS: "30000",
  FIREBLOCKS_API_KEY: "fireblocks-key-k4w",
  FIREBLOCKS_API_SECRET: "fireblocks-secret-k4w",
  PRIVY_APP_ID: "app_k4w",
  PRIVY_APP_SECRET: "privy-secret-k4w",
  SAFE_PROXY_AUDIENCE: "https://safe-proxy-k4w.a.run.app",
  SAFE_PROXY_API_CALLER: API_CALLER,
  SAFE_PROXY_CRON_CALLER: "cron-k4w@sdp-test.iam.gserviceaccount.com",
};

// Starts the Cloud Run proxy with settings that fail, so it exits before fetching Google's keys.
async function startupFailure(
  settings: { SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: string } & Partial<typeof CLOUD_RUN>
) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, ...CLOUD_RUN, ...settings },
    stdio: ["ignore", "ignore", "pipe"],
    // A proxy that starts anyway is stopped here and fails the exit assertion.
    signal: AbortSignal.timeout(15_000),
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.ok(!stderr.includes("k4w"), "stderr carries a setting's value");
  const failure = /^Error: (invalid settings: .*)$/m.exec(stderr);
  assert.ok(failure, "stderr names no settings");
  return failure[1];
}

it("on Cloud Run, does not start on a token age outside its bounds, naming only that setting", async () => {
  for (const seconds of [IDENTITY_TOKEN_REFETCH_AFTER_SECONDS, 3601]) {
    assert.equal(
      await startupFailure({ SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: String(seconds) }),
      "invalid settings: SAFE_PROXY_MAX_TOKEN_AGE_SECONDS"
    );
  }
});

it("on Cloud Run, does not start with one account for both callers, naming only that setting", async () => {
  // Token ages at both bounds pass their check, so the caller check is the one that fails.
  for (const seconds of [IDENTITY_TOKEN_REFETCH_AFTER_SECONDS + 1, 3600]) {
    assert.equal(
      await startupFailure({
        SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: String(seconds),
        SAFE_PROXY_CRON_CALLER: API_CALLER,
      }),
      "invalid settings: SAFE_PROXY_CRON_CALLER"
    );
  }
});
