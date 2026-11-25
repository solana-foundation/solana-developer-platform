import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { createLocalCallerCheck } from "./caller";

it("the local entry does not start on Cloud Run", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/local.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, K_SERVICE: "sdp-safe-proxy" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "exit");

  assert.equal(code, 1);
  assert.match(stderr, /the local entry does not run on Cloud Run: K_SERVICE is set/);
});

it("the local caller check takes a caller only on its loopback address, naming itself", async () => {
  const identify = createLocalCallerCheck({ hostname: "127.0.0.1", port: 8791 });
  const headers = (host: string, caller: string) =>
    new Headers({ host, [LOCAL_CALLER_HEADER]: caller });

  assert.equal(await identify(headers("127.0.0.1:8791", "cron")), "cron");
  await assert.rejects(identify(headers("localhost:8791", "api")), { code: "unauthenticated" });
  await assert.rejects(identify(headers("127.0.0.1:8791", "admin")), { code: "unauthenticated" });
});
