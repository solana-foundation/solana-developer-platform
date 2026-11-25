import assert from "node:assert/strict";
import { it } from "node:test";
import { parseServerSettings } from "./settings";

it("names a missing or invalid setting and never its value", () => {
  const env = {
    SAFE_PROXY_PROVIDER_TIMEOUT_MS: "30000",
    PRIVY_APP_ID: "privy-app-1",
    FIREBLOCKS_API_KEY: "fireblocks-key-1",
    FIREBLOCKS_API_SECRET: "fireblocks-secret-9e2a",
    PORT: "8080",
    K_REVISION: "sdp-safe-proxy-00042",
    SAFE_PROXY_AUDIENCE: "https://safe-proxy.example.com",
    SAFE_PROXY_API_CALLER: "api@project.iam.gserviceaccount.com",
    SAFE_PROXY_CRON_CALLER: "cron@project.iam.gserviceaccount.com",
    SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: "300",
  };

  assert.throws(() => parseServerSettings(env), {
    message: "invalid settings: PRIVY_APP_SECRET, FIREBLOCKS_API_SECRET",
  });
});
