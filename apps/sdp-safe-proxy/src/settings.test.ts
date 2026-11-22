import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { parseLocalSettings, parseServerSettings } from "./settings";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials = {
  SAFE_PROXY_MAX_BUDGET_MS: "60000",
  PRIVY_APP_ID: "privy-app-1",
  PRIVY_APP_SECRET: "privy-secret-1",
  FIREBLOCKS_API_KEY: "fireblocks-key-1",
  FIREBLOCKS_API_SECRET: privateKey,
};
const serverEnv = {
  ...credentials,
  PORT: "8080",
  K_REVISION: "sdp-safe-proxy-00042",
  SAFE_PROXY_AUDIENCE: "https://safe-proxy.example.com",
  SAFE_PROXY_API_CALLER: "api@project.iam.gserviceaccount.com",
  SAFE_PROXY_CRON_CALLER: "cron@project.iam.gserviceaccount.com",
  SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: "300",
};
const localEnv = { ...credentials, SDP_SAFE_PROXY_PORT: "8791" };

function without(env: Record<string, string>, name: string): Record<string, string> {
  const { [name]: _removed, ...rest } = env;
  return rest;
}

describe("parseServerSettings", () => {
  it("reads a complete environment", () => {
    assert.deepEqual(parseServerSettings({ ...serverEnv, PATH: "/usr/bin" }), {
      ...serverEnv,
      FIREBLOCKS_API_SECRET: privateKey.trim(),
      PORT: 8080,
      SAFE_PROXY_MAX_BUDGET_MS: 60000,
      SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: 300,
    });
  });

  for (const name of Object.keys(serverEnv)) {
    it(`fails naming ${name} when it is missing`, () => {
      assert.throws(() => parseServerSettings(without(serverEnv, name)), {
        message: `invalid settings: ${name}`,
      });
    });
  }

  const invalid = [
    ["an http audience", "SAFE_PROXY_AUDIENCE", "http://safe-proxy-7c1e.example.com"],
    ["a caller that is not an email", "SAFE_PROXY_API_CALLER", "caller-value-4b1d"],
    ["a credential that is not a key", "FIREBLOCKS_API_SECRET", "fireblocks-secret-9e2a"],
    [
      "a key that is not PKCS#8",
      "FIREBLOCKS_API_SECRET",
      createPrivateKey(privateKey).export({ type: "pkcs1", format: "pem" }).toString(),
    ],
  ] as const;
  for (const [description, name, value] of invalid) {
    it(`rejects ${description}, naming ${name} and not the value`, () => {
      assert.throws(() => parseServerSettings({ ...serverEnv, [name]: value }), {
        message: `invalid settings: ${name}`,
      });
    });
  }

  it("rejects the same account for both callers", () => {
    const sameCaller = { ...serverEnv, SAFE_PROXY_CRON_CALLER: serverEnv.SAFE_PROXY_API_CALLER };
    assert.throws(() => parseServerSettings(sameCaller), {
      message: /^invalid settings: SAFE_PROXY_(API|CRON)_CALLER$/,
    });
  });

  it("reads the Fireblocks key with real line breaks and with them written as \\n", () => {
    const escaped = privateKey.trim().replaceAll("\n", "\\n");
    assert.doesNotMatch(escaped, /\n/);

    const fromLines = parseServerSettings(serverEnv).FIREBLOCKS_API_SECRET;
    const fromEscaped = parseServerSettings({
      ...serverEnv,
      FIREBLOCKS_API_SECRET: escaped,
    }).FIREBLOCKS_API_SECRET;

    assert.equal(fromEscaped, fromLines);
    assert.equal(createPrivateKey(fromEscaped).asymmetricKeyType, "rsa");
  });
});

describe("parseLocalSettings", () => {
  it("reads a complete environment", () => {
    assert.deepEqual(parseLocalSettings(localEnv), {
      ...localEnv,
      FIREBLOCKS_API_SECRET: privateKey.trim(),
      SDP_SAFE_PROXY_PORT: 8791,
      SAFE_PROXY_MAX_BUDGET_MS: 60000,
    });
  });

  for (const name of Object.keys(localEnv)) {
    it(`fails naming ${name} when it is missing`, () => {
      assert.throws(() => parseLocalSettings(without(localEnv, name)), {
        message: `invalid settings: ${name}`,
      });
    });
  }
});
