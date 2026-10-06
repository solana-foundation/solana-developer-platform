import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createRpc } from "@sdp/rpc/solana";
import type { Base64EncodedWireTransaction, Slot } from "@solana/kit";
import {
  Agent,
  type Dispatcher,
  fetch as fetchVia,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "@/runtime/logger";
import { createOutboundDispatcher, installOutboundDispatcher } from "./outbound-dispatcher";

/**
 * A loopback JSON-RPC server that, like a public Solana RPC, sends no
 * Keep-Alive hint and never closes an idle socket itself, so every socket the
 * client opens is one more TCP connect (and, behind Cloud NAT, one more port).
 */
async function startCountingServer() {
  let opened = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id, params } = JSON.parse(body) as { id: unknown; params: unknown[] };
      const result = 1_700_000_000 + Number(params[0]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  server.keepAliveTimeout = 0;
  server.on("connection", () => {
    opened += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    opened: () => opened,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A loopback RPC that answers `sendTransaction` at once and holds every read
 * until released, so a send can only be answered if it was not queued behind
 * the reads.
 */
async function startHoldingServer() {
  let opened = 0;
  const held: Array<() => void> = [];
  let onHeld: (() => void) | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      const answer = () => {
        const result = method === "sendTransaction" ? "5aBcSignature" : 42;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (method === "sendTransaction") {
        answer();
        return;
      }
      held.push(answer);
      onHeld?.();
    });
  });
  server.on("connection", () => {
    opened += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    opened: () => opened,
    held: () => held.length,
    /** Resolves once `count` reads are held at the server at the same time. */
    holding: (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`only ${held.length} of ${count} reads reached the server`)),
          5_000
        );
        onHeld = () => {
          if (held.length < count) return;
          clearTimeout(timer);
          resolve();
        };
        onHeld();
      }),
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** One refresh: `lanes` distinct block-time reads in parallel through `dispatcher`. */
function refreshVia(url: string, dispatcher: Dispatcher, lanes: number) {
  return Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      const response = await fetchVia(url, {
        method: "POST",
        dispatcher,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: lane, method: "getBlockTime", params: [lane] }),
      });
      return response.json();
    })
  );
}

async function callVia(url: string, dispatcher: Dispatcher, method: string, id: number) {
  const response = await fetchVia(url, {
    method: "POST",
    dispatcher,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
  });
  return response.json();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimeBundlesUndici7 = process.versions.undici?.split(".")[0] === "7";
const BURST = 40;
const dispatchers: Dispatcher[] = [];
let previous: Dispatcher | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (previous) setGlobalDispatcher(previous);
  previous = undefined;
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
});

describe("outbound dispatcher", () => {
  it("keeps a refresh's sockets across a gap the default pool drops", async () => {
    const before = await startCountingServer();
    const after = await startCountingServer();
    const defaultPool = new Agent();
    const outbound = createOutboundDispatcher();
    dispatchers.push(defaultPool, outbound);
    try {
      const newSockets = { before: [] as number[], after: [] as number[] };
      const answers = { before: [] as unknown[], after: [] as unknown[] };
      for (const gapMs of [0, 7_000]) {
        await sleep(gapMs);
        const counts = { before: before.opened(), after: after.opened() };
        const [beforeAnswer, afterAnswer] = await Promise.all([
          refreshVia(before.url, defaultPool, 6),
          refreshVia(after.url, outbound, 6),
        ]);
        newSockets.before.push(before.opened() - counts.before);
        newSockets.after.push(after.opened() - counts.after);
        answers.before.push(beforeAnswer);
        answers.after.push(afterAnswer);
      }

      expect(newSockets).toEqual({ before: [6, 6], after: [6, 0] });
      expect(answers.after).toEqual(answers.before);
    } finally {
      await Promise.all([before.close(), after.close()]);
    }
  }, 20_000);

  it(`answers a send while ${BURST} reads to the same origin are still open`, async () => {
    const server = await startHoldingServer();
    const outbound = createOutboundDispatcher();
    dispatchers.push(outbound);
    try {
      const reads = Array.from({ length: BURST }, (_, lane) =>
        callVia(server.url, outbound, "getSlot", lane)
      );
      await server.holding(BURST);

      const send = await callVia(server.url, outbound, "sendTransaction", BURST);

      expect(send).toEqual({ jsonrpc: "2.0", id: BURST, result: "5aBcSignature" });
      expect(server.held()).toBe(BURST);
      server.release();
      await expect(Promise.all(reads)).resolves.toHaveLength(BURST);
      expect(server.opened()).toBe(BURST + 1);
    } finally {
      await server.close();
    }
  }, 10_000);

  it.runIf(runtimeBundlesUndici7)(
    "is the pool createRpc uses once installed, and its send passes a read burst",
    async () => {
      const server = await startHoldingServer();
      previous = getGlobalDispatcher();
      const installed = installOutboundDispatcher();
      if (installed) dispatchers.push(installed);
      try {
        expect(getGlobalDispatcher()).toBe(installed);
        const rpc = createRpc({}, { rpcUrl: server.url });
        // Distinct reads: kit coalesces identical requests made together.
        const reads = Array.from({ length: BURST }, (_, lane) =>
          rpc.getBlockTime(BigInt(lane) as Slot).send()
        );
        await server.holding(BURST);

        const signature = await rpc
          .sendTransaction("AQ==" as Base64EncodedWireTransaction, { encoding: "base64" })
          .send();

        expect(signature).toBe("5aBcSignature");
        expect(server.held()).toBe(BURST);
        server.release();
        await expect(Promise.all(reads)).resolves.toEqual(Array(BURST).fill(42n));
        expect(installed?.stats[server.url]?.connected).toBe(BURST + 1);
      } finally {
        await server.close();
      }
    },
    10_000
  );
});

describe("installOutboundDispatcher", () => {
  it("installs the Agent globally on a runtime that bundles undici 7", async () => {
    previous = getGlobalDispatcher();
    const installed = installOutboundDispatcher("7.29.0");
    if (installed) dispatchers.push(installed);

    expect(installed).toBeInstanceOf(Agent);
    expect(getGlobalDispatcher()).toBe(installed);
  });

  // The only test in this file that takes the skip branch, so the log-once flag is fresh here.
  it("keeps Node's default pool on any other undici major, and says so once", () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const current = getGlobalDispatcher();

    expect(installOutboundDispatcher("8.10.2")).toBeUndefined();
    expect(installOutboundDispatcher("6.28.0")).toBeUndefined();
    expect(installOutboundDispatcher("")).toBeUndefined();

    expect(getGlobalDispatcher()).toBe(current);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { runtimeUndici: "8.10.2", pairedUndiciMajor: 7 },
      expect.stringContaining("Node's default pool stays")
    );
  });

  // After the skip test, so a mismatch here cannot spend its log-once flag.
  it("is paired with the npm undici its Agent comes from", () => {
    const { version } = createRequire(import.meta.url)("undici/package.json") as {
      version: string;
    };
    previous = getGlobalDispatcher();
    const installed = installOutboundDispatcher(version);
    if (installed) dispatchers.push(installed);

    // Installs only on PAIRED_UNDICI_MAJOR, so an npm major bump fails here.
    expect(installed).toBeInstanceOf(Agent);
  });
});
