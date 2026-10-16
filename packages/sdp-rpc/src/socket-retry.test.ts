import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, it, type TestContext } from "node:test";
import {
  address,
  type Base64EncodedWireTransaction,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";
import { contextAwareRpcFetch, withMinimumRpcSlot, withRpcReadContext } from "./read-context";
import { fetchWithReadSocketRetry, withReadSocketRetry } from "./socket-retry";
import { createRpc } from "./solana";

const socketDeath = (code: string | undefined, message: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

function scriptedTransport(outcomes: unknown[]) {
  const sent: unknown[] = [];
  const transport = (async (config: Parameters<RpcTransport>[0]) => {
    sent.push(config.payload);
    const outcome = outcomes[Math.min(sent.length - 1, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as RpcTransport;
  return { sent, transport };
}

const payload = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });
/** Sends, simulation, and the blockhash and fee reads a transaction is built on. */
const NEVER_RESENT = [
  "sendTransaction",
  "simulateTransaction",
  "requestAirdrop",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getRecentBlockhash",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
];
/** Lets undici return a finished request's socket to the pool before the next send. */
const pooled = () => new Promise((resolve) => setTimeout(resolve, 10));
const ANSWER = { jsonrpc: "2.0", id: 1, result: 7 };

describe("withReadSocketRetry", () => {
  for (const [label, error] of [
    ["an undici socket error", socketDeath("UND_ERR_SOCKET", "other side closed")],
    ["a connection reset", socketDeath("ECONNRESET", "read ECONNRESET")],
    ["an uncoded close", socketDeath(undefined, "other side closed")],
  ] as const) {
    it(`re-sends a read once after ${label} before any response`, async () => {
      const { sent, transport } = scriptedTransport([error, ANSWER]);
      const response = await withReadSocketRetry(transport)({ payload: payload("getSlot") });
      assert.deepEqual(response, ANSWER);
      assert.equal(sent.length, 2);
    });
  }

  for (const method of [...NEVER_RESENT, "custom"]) {
    it(`never re-sends ${method}`, async () => {
      const error = socketDeath("UND_ERR_SOCKET", "other side closed");
      const { sent, transport } = scriptedTransport([error, ANSWER]);
      await assert.rejects(withReadSocketRetry(transport)({ payload: payload(method) }), error);
      assert.equal(sent.length, 1);
    });
  }

  for (const [label, error] of [
    [
      "a body that died after the headers",
      new TypeError("terminated", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ],
    ["a refused connection", socketDeath("ECONNREFUSED", "connect ECONNREFUSED")],
    ["a connect timeout", socketDeath("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")],
    ["an HTTP or RPC error", new Error("HTTP error (503)")],
  ] as const) {
    it(`surfaces ${label} without a retry`, async () => {
      const { sent, transport } = scriptedTransport([error, ANSWER]);
      await assert.rejects(withReadSocketRetry(transport)({ payload: payload("getSlot") }), error);
      assert.equal(sent.length, 1);
    });
  }

  it("retries once at most, and never a batch or an aborted request", async () => {
    const error = socketDeath("UND_ERR_SOCKET", "other side closed");
    const twice = scriptedTransport([error, error, ANSWER]);
    await assert.rejects(withReadSocketRetry(twice.transport)({ payload: payload("getSlot") }));
    assert.equal(twice.sent.length, 2);

    const batch = scriptedTransport([error, ANSWER]);
    await assert.rejects(
      withReadSocketRetry(batch.transport)({ payload: [payload("getSlot"), payload("getSlot")] })
    );
    assert.equal(batch.sent.length, 1);

    const controller = new AbortController();
    controller.abort();
    const aborted = scriptedTransport([error, ANSWER]);
    await assert.rejects(
      withReadSocketRetry(aborted.transport)({
        payload: payload("getSlot"),
        signal: controller.signal,
      })
    );
    assert.equal(aborted.sent.length, 1);
  });
});

describe("fetchWithReadSocketRetry", () => {
  /** Global fetch whose first call dies on its socket; later calls answer. */
  function dyingFetch(t: TestContext) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls === 1) throw socketDeath("UND_ERR_SOCKET", "other side closed");
      return Response.json(ANSWER);
    });
    return () => calls;
  }
  const post = (method: string) =>
    fetchWithReadSocketRetry("https://rpc.example", {
      method: "POST",
      body: JSON.stringify(payload(method)),
    });

  it("re-sends a read once after its socket died", async (t) => {
    const calls = dyingFetch(t);
    const response = await post("getSlot");
    assert.deepEqual(await response.json(), ANSWER);
    assert.equal(calls(), 2);
  });

  for (const method of NEVER_RESENT) {
    it(`never re-sends ${method}`, async (t) => {
      const calls = dyingFetch(t);
      await assert.rejects(post(method), /fetch failed/);
      assert.equal(calls(), 1);
    });
  }
});

/**
 * A loopback JSON-RPC server whose pooled keep-alive sockets die the way an
 * upstream's idle close races a reuse: every request after the first on one
 * socket is dropped, before any response byte or after the headers.
 */
async function startDroppingServer(drop: "before-response" | "mid-body") {
  const methods: string[] = [];
  const served = new WeakMap<Socket, number>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      methods.push(method);
      const count = (served.get(request.socket) ?? 0) + 1;
      served.set(request.socket, count);
      if (count > 1 && drop === "before-response") {
        request.socket.destroy();
        return;
      }
      const result = method.includes("Account") ? { context: { slot: 150 }, value: null } : 42;
      const text = JSON.stringify({ jsonrpc: "2.0", id, result });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(text.length),
      });
      if (count > 1) {
        response.write(text.slice(0, 10));
        setTimeout(() => request.socket.destroy(), 10);
        return;
      }
      response.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    methods,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("a reused socket that dies before the response (loopback)", () => {
  it("fails a plain kit read; the createRpc read answers the same value", async () => {
    const plainServer = await startDroppingServer("before-response");
    const sharedServer = await startDroppingServer("before-response");
    try {
      const plain = createSolanaRpcFromTransport(
        createDefaultRpcTransport({ url: plainServer.url })
      );
      assert.equal(await plain.getSlot().send(), 42n);
      await pooled();
      await assert.rejects(plain.getSlot().send(), /fetch failed/);
      assert.deepEqual(plainServer.methods, ["getSlot", "getSlot"]);

      const rpc = createRpc({}, { rpcUrl: sharedServer.url });
      assert.equal(await rpc.getSlot().send(), 42n);
      await pooled();
      assert.equal(await rpc.getSlot().send(), 42n);
      assert.deepEqual(sharedServer.methods, ["getSlot", "getSlot", "getSlot"]);
    } finally {
      await Promise.all([plainServer.close(), sharedServer.close()]);
    }
  });

  it("never re-sends a transaction on a dead socket", async () => {
    const server = await startDroppingServer("before-response");
    try {
      const rpc = createRpc({}, { rpcUrl: server.url });
      await rpc.getSlot().send();
      await pooled();
      await assert.rejects(
        rpc.sendTransaction("AQ==" as Base64EncodedWireTransaction, { encoding: "base64" }).send(),
        /fetch failed/
      );
      assert.deepEqual(server.methods, ["getSlot", "sendTransaction"]);
    } finally {
      await server.close();
    }
  });

  it("never re-sends a blockhash read on a dead socket, through either seam", async () => {
    const server = await startDroppingServer("before-response");
    try {
      const rpc = createRpc({}, { rpcUrl: server.url });
      await rpc.getSlot().send();
      await pooled();
      await assert.rejects(rpc.getLatestBlockhash().send(), /fetch failed/);

      const post = (method: string) =>
        contextAwareRpcFetch(server.url, { method: "POST", body: JSON.stringify(payload(method)) });
      await (await post("getSlot")).json();
      await pooled();
      await assert.rejects(post("getLatestBlockhash"), /fetch failed/);
      assert.deepEqual(server.methods, [
        "getSlot",
        "getLatestBlockhash",
        "getSlot",
        "getLatestBlockhash",
      ]);
    } finally {
      await server.close();
    }
  });

  it("never re-sends once a response has started", async () => {
    const server = await startDroppingServer("mid-body");
    try {
      const rpc = createRpc({}, { rpcUrl: server.url });
      await rpc.getSlot().send();
      await pooled();
      await assert.rejects(rpc.getSlot().send(), /terminated/);
      assert.deepEqual(server.methods, ["getSlot", "getSlot"]);
    } finally {
      await server.close();
    }
  });

  it("keeps a minimum-slot scope valid when the answer came from the retry", async () => {
    const server = await startDroppingServer("before-response");
    try {
      const rpc = createRpc({}, { rpcUrl: server.url, wrapTransport: withRpcReadContext });
      await rpc.getSlot().send();
      await pooled();
      const account = await withMinimumRpcSlot(100, () =>
        rpc.getAccountInfo(address("11111111111111111111111111111111")).send()
      );
      assert.equal(account.context.slot, 150n);
      assert.deepEqual(server.methods, ["getSlot", "getAccountInfo", "getAccountInfo"]);
    } finally {
      await server.close();
    }
  });

  it("re-sends a web3.js or direct JSON read in and out of a minimum-slot scope", async () => {
    const server = await startDroppingServer("before-response");
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [["11111111111111111111111111111111"], { encoding: "base64" }],
      });
      const post = async () => {
        const response = await contextAwareRpcFetch(server.url, { method: "POST", body });
        const json: unknown = await response.json();
        await pooled();
        return json;
      };
      await post();
      await post();
      const scoped = await withMinimumRpcSlot(100, post);
      assert.deepEqual(scoped, {
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 150 }, value: null },
      });
      assert.equal(server.methods.length, 5);

      const send = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction" });
      await assert.rejects(
        contextAwareRpcFetch(server.url, { method: "POST", body: send }),
        /fetch failed/
      );
      assert.equal(server.methods.at(-1), "sendTransaction");
      assert.equal(server.methods.length, 6);
    } finally {
      await server.close();
    }
  });
});
