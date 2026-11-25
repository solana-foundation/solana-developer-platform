import assert from "node:assert/strict";
import { it } from "node:test";
import { IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "@sdp/metadata-server/caller";
import { parseServerSettings } from "./settings";
import { PLATFORM_CREDENTIALS } from "./test/helpers/forward-app";

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

it("names a missing or invalid setting and never its value", () => {
  assert.throws(() => parseServerSettings(env), {
    message: "invalid settings: PRIVY_APP_SECRET, FIREBLOCKS_API_SECRET",
  });
});

it("accepts a token age only above the age at which callers fetch a new token", () => {
  const validEnv = {
    ...env,
    PRIVY_APP_SECRET: PLATFORM_CREDENTIALS.privy.appSecret,
    FIREBLOCKS_API_SECRET: PLATFORM_CREDENTIALS.fireblocks.apiSecretPem,
  };
  const withAge = (seconds: number) => ({
    ...validEnv,
    SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: String(seconds),
  });

  assert.throws(() => parseServerSettings(withAge(IDENTITY_TOKEN_REFETCH_AFTER_SECONDS)), {
    message: "invalid settings: SAFE_PROXY_MAX_TOKEN_AGE_SECONDS",
  });
  const settings = parseServerSettings(withAge(IDENTITY_TOKEN_REFETCH_AFTER_SECONDS + 1));
  assert.equal(settings.SAFE_PROXY_MAX_TOKEN_AGE_SECONDS, IDENTITY_TOKEN_REFETCH_AFTER_SECONDS + 1);
});
