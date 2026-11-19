import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSettings } from "@/settings";

const googleEnv = {
  SAFE_PROXY_CALLER_AUTH: "google",
  PORT: "8080",
  SAFE_PROXY_AUDIENCE: "https://safe-proxy.example.com",
  SAFE_PROXY_API_CALLER_EMAIL: "api@example.com",
  SAFE_PROXY_CRON_CALLER_EMAIL: "cron@example.com",
};

const localEnv = { SAFE_PROXY_CALLER_AUTH: "local", PORT: "8791" };

describe("readSettings", () => {
  it("parses a complete google environment", () => {
    assert.deepEqual(readSettings(googleEnv), {
      callerAuth: "google",
      port: 8080,
      audience: "https://safe-proxy.example.com",
      callerEmails: { api: "api@example.com", cron: "cron@example.com" },
    });
  });

  it("refuses a missing or malformed google setting", () => {
    const broken = {
      "missing audience": { ...googleEnv, SAFE_PROXY_AUDIENCE: undefined },
      "http audience": { ...googleEnv, SAFE_PROXY_AUDIENCE: "http://safe-proxy.example.com" },
      "non-email api caller": { ...googleEnv, SAFE_PROXY_API_CALLER_EMAIL: "api" },
      "non-email cron caller": { ...googleEnv, SAFE_PROXY_CRON_CALLER_EMAIL: "cron" },
      "missing port": { ...googleEnv, PORT: undefined },
      "port 0": { ...googleEnv, PORT: "0" },
      "port above 65535": { ...googleEnv, PORT: "65536" },
      "non-numeric port": { ...googleEnv, PORT: "http" },
      "unknown caller auth": { ...googleEnv, SAFE_PROXY_CALLER_AUTH: "none" },
      "missing caller auth": { ...googleEnv, SAFE_PROXY_CALLER_AUTH: undefined },
    };
    for (const [label, env] of Object.entries(broken)) {
      assert.throws(() => readSettings(env), label);
    }
  });

  it("refuses the same account for the api and cron callers", () => {
    assert.throws(
      () => readSettings({ ...googleEnv, SAFE_PROXY_CRON_CALLER_EMAIL: "api@example.com" }),
      /must name different accounts/
    );
  });

  it("parses local mode off Cloud Run and refuses it on Cloud Run", () => {
    assert.deepEqual(readSettings(localEnv), { callerAuth: "local", port: 8791 });
    assert.throws(() => readSettings({ ...localEnv, K_SERVICE: "sdp-safe-proxy" }));
  });
});
