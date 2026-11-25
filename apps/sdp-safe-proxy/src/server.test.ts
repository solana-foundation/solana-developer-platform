import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("does not start without a secret, naming the setting and no setting's value", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH,
      SDP_SAFE_PROXY_PORT: "48791",
      SAFE_PROXY_PROVIDER_TIMEOUT_MS: "30000",
      FIREBLOCKS_API_KEY: "fireblocks-key-k4w",
      FIREBLOCKS_API_SECRET: String(privateKey.export({ type: "pkcs8", format: "pem" })),
      PRIVY_APP_ID: "app_7k2",
      PRIVY_APP_SECRET: "",
    },
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
  assert.match(stderr, /missing setting: PRIVY_APP_SECRET/);
  for (const value of ["fireblocks-key-k4w", "PRIVATE KEY", "app_7k2"]) {
    assert.ok(!stderr.includes(value), `stderr carries the value ${value}`);
  }
});
