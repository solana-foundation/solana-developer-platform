import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "@sdp/metadata-server/caller";
import type { SafeProxyProvider } from "@/endpoints/providers";
import { channelOfferingOne, EVERY_PROVIDER_CHANNEL } from "./test/helpers/release-channels";

// Every text value carries k4w, so stderr must never carry k4w. Cloud Run unless K_SERVICE is unset.
const API_CALLER = "api-k4w@sdp-test.iam.gserviceaccount.com";
const SETTINGS = {
  K_SERVICE: "sdp-safe-proxy",
  PORT: "48791",
  SAFE_PROXY_PROVIDER_TIMEOUT_MS: "30000",
  SDP_RELEASE_CHANNEL: EVERY_PROVIDER_CHANNEL,
  SDP_SAFE_PROXY_PORT: "48792",
  SAFE_PROXY_AUDIENCE: "https://safe-proxy-k4w.a.run.app",
  SAFE_PROXY_API_CALLER: API_CALLER,
  SAFE_PROXY_CRON_CALLER: "cron-k4w@sdp-test.iam.gserviceaccount.com",
};

// Starts the proxy with settings that fail before it fetches Google's keys.
async function startupFailure(
  settings: Partial<typeof SETTINGS & { SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: string }>
) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, ...SETTINGS, ...settings },
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

it("does not start without a release channel, naming that setting", async () => {
  assert.equal(
    await startupFailure({ SDP_RELEASE_CHANNEL: undefined }),
    "invalid settings: SDP_RELEASE_CHANNEL"
  );
});

const CREDENTIAL_SETTINGS = {
  fireblocks: "invalid settings: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET",
  privy: "invalid settings: PRIVY_APP_ID, PRIVY_APP_SECRET",
} as const satisfies Record<SafeProxyProvider, string>;

it("requires the credential settings of the providers in its release channel, and only theirs", async () => {
  const { releaseChannel, offered } = channelOfferingOne();
  assert.equal(
    await startupFailure({ K_SERVICE: undefined, SDP_RELEASE_CHANNEL: releaseChannel }),
    CREDENTIAL_SETTINGS[offered]
  );
});
