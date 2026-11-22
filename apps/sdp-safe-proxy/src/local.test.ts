import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { createLocalCallerCheck } from "./local-caller";

it("the local entry does not start on Cloud Run", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/local.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", K_SERVICE: "sdp-safe-proxy" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "exit");

  assert.deepEqual(
    { code, stderr },
    { code: 1, stderr: "the local entry does not run on Cloud Run: K_SERVICE is set\n" }
  );
});

it("the local entry refuses a request not addressed to its loopback address", async () => {
  const identify = createLocalCallerCheck({ hostname: "127.0.0.1", port: 8791 });
  const headers = (host: string) => new Headers({ host, [LOCAL_CALLER_HEADER]: "api" });

  assert.deepEqual(await identify(headers("127.0.0.1:8791")), {
    caller: "api",
    tokenAgeSeconds: null,
  });
  await assert.rejects(identify(headers("localhost:8791")), { code: "unauthenticated" });
});
