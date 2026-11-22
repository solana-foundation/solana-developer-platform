import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FORWARD_HEADERS, LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

function localEnv(port: number): Record<string, string> {
  return {
    SDP_SAFE_PROXY_PORT: String(port),
    SAFE_PROXY_MAX_BUDGET_MS: "60000",
    PRIVY_APP_ID: "privy-app-1",
    PRIVY_APP_SECRET: "privy-secret-1",
    FIREBLOCKS_API_KEY: "fireblocks-key-1",
    FIREBLOCKS_API_SECRET: privateKey,
  };
}

function startLocal(env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", "src/local.ts"], {
    cwd: packageDir,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, stderr: () => stderr };
}

async function exitOf(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const { child, stderr } = startLocal(env);
  const [code] = await once(child, "exit");
  return { code, stderr: stderr() };
}

describe("local entry", () => {
  it("does not start on Cloud Run", async () => {
    const env = { ...localEnv(await freePort()), K_SERVICE: "sdp-safe-proxy" };
    assert.deepEqual(await exitOf(env), {
      code: 1,
      stderr: "the local entry does not run on Cloud Run: K_SERVICE is set\n",
    });
  });

  it("does not start with a setting missing, naming it", async () => {
    const { PRIVY_APP_SECRET: _missing, ...env } = localEnv(await freePort());
    assert.deepEqual(await exitOf(env), {
      code: 1,
      stderr: "invalid settings: PRIVY_APP_SECRET\n",
    });
  });

  describe("running", () => {
    let port: number;
    let local: ReturnType<typeof startLocal> | undefined;

    before(
      async () => {
        port = await freePort();
        local = startLocal(localEnv(port));
        for (;;) {
          assert.equal(local.child.exitCode, null, `local entry exited: ${local.stderr()}`);
          const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
          if (health !== null) return assert.equal(health.status, 200);
          await delay(20);
        }
      },
      { timeout: 15_000 }
    );

    after(async () => {
      if (local?.child.exitCode === null && local.child.kill("SIGKILL")) {
        await once(local.child, "exit");
      }
    });

    it("accepts no connection on an address other than loopback", async (t) => {
      const external = Object.values(networkInterfaces())
        .flat()
        .find((address) => address?.family === "IPv4" && !address.internal);
      if (external === undefined) return t.skip("no non-loopback IPv4 address on this host");

      const socket = connect(port, external.address);
      const outcome = await new Promise((resolve) => {
        socket.once("connect", () => resolve("connected"));
        socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
      });
      socket.destroy();
      assert.equal(outcome, "ECONNREFUSED");
    });

    async function forward(caller: string | undefined) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/forward/fireblocks/v1/undeclared`, {
        headers: {
          [FORWARD_HEADERS.requestId]: "req-1",
          [FORWARD_HEADERS.budgetMs]: "1000",
          ...(caller === undefined ? {} : { [LOCAL_CALLER_HEADER]: caller }),
        },
      });
      return {
        status: response.status,
        result: response.headers.get(FORWARD_HEADERS.result),
        body: await response.json(),
      };
    }

    it("refuses a request that names no caller", async () => {
      assert.deepEqual(await forward(undefined), {
        status: 401,
        result: "refused",
        body: { code: "unauthenticated" },
      });
    });

    it("refuses a request that names an unknown caller", async () => {
      assert.deepEqual(await forward("auditor"), {
        status: 401,
        result: "refused",
        body: { code: "unauthenticated" },
      });
    });

    it("lets a named caller through to the endpoint check", async () => {
      assert.deepEqual(await forward("api"), {
        status: 403,
        result: "refused",
        body: { code: "endpoint_not_allowed" },
      });
    });
  });
});
