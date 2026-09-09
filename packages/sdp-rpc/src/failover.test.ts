import assert from "node:assert/strict";
import test from "node:test";
import type { RpcTransport } from "@solana/kit";
import { resolveSolanaRpcProviderUrls } from "./config";
import { createFailoverTransport } from "./solana";
import type { RpcEnv } from "./types";

function makeTransport(behaviors: Array<"ok" | "http500" | "invalid">): {
  transport: RpcTransport;
  calls: number;
} {
  const state = { calls: 0 };
  const transport = (async () => {
    const behavior = behaviors[Math.min(state.calls, behaviors.length - 1)];
    state.calls += 1;
    if (behavior === "http500") {
      throw new Error("HTTP error (500): Internal server error");
    }
    if (behavior === "invalid") {
      throw new Error("invalid params");
    }
    return { ok: true };
  }) as unknown as RpcTransport;
  return {
    transport,
    get calls() {
      return state.calls;
    },
  };
}

const request = (method: string) => ({ payload: { jsonrpc: "2.0", id: 1, method, params: [] } });

test("fails over to the next provider on a transient error", async () => {
  const a = makeTransport(["http500"]);
  const b = makeTransport(["ok"]);
  const transport = createFailoverTransport([a.transport, b.transport], { stickyKey: "t1" });

  const result = await transport(request("getBalance"));

  assert.deepEqual(result, { ok: true });
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
});

test("remembers the healthy provider for later requests on the same key", async () => {
  const a = makeTransport(["http500"]);
  const b = makeTransport(["ok", "ok"]);
  const transport = createFailoverTransport([a.transport, b.transport], { stickyKey: "t2" });

  await transport(request("getBalance"));
  await transport(request("getAccountInfo"));

  assert.equal(a.calls, 1);
  assert.equal(b.calls, 2);
});

test("does not fail over on a non-transient error", async () => {
  const a = makeTransport(["invalid"]);
  const b = makeTransport(["ok"]);
  const transport = createFailoverTransport([a.transport, b.transport], { stickyKey: "t3" });

  await assert.rejects(() => transport(request("getBalance")), /invalid params/);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 0);
});

test("never resubmits sendTransaction through another provider", async () => {
  const a = makeTransport(["http500"]);
  const b = makeTransport(["ok"]);
  const transport = createFailoverTransport([a.transport, b.transport], { stickyKey: "t4" });

  await assert.rejects(() => transport(request("sendTransaction")), /500/);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 0);
});

test("throws the last error when every provider fails transiently", async () => {
  const a = makeTransport(["http500"]);
  const b = makeTransport(["http500"]);
  const transport = createFailoverTransport([a.transport, b.transport], { stickyKey: "t5" });

  await assert.rejects(() => transport(request("getBalance")), /500/);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
});

test("orders provider urls with the preferred default first and de-duplicates", () => {
  const env = {
    SOLANA_RPC_TRITON_URL: "https://triton.example/${API_KEY}",
    SOLANA_RPC_TRITON_API_KEY: "t",
    SOLANA_RPC_HELIUS_URL: "https://helius.example",
    SOLANA_RPC_HELIUS_API_KEY: "h",
    SOLANA_RPC_URL: "https://helius.example/?api-key=h",
    SOLANA_RPC_DEFAULT_PROVIDER: "helius",
  } as unknown as RpcEnv;

  const urls = resolveSolanaRpcProviderUrls(env);

  assert.equal(urls[0], "https://helius.example/?api-key=h");
  assert.equal(urls.length, 2);
  assert.ok(urls[1].startsWith("https://triton.example/"));
});

test("a stalled provider is cut by its per-attempt deadline and the next provider answers", async () => {
  const { withRequestTimeout } = await import("./solana");
  let stalledCalls = 0;
  const stalled = ((request: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      stalledCalls += 1;
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as RpcTransport;
  const b = makeTransport(["ok"]);
  const transport = createFailoverTransport(
    [withRequestTimeout(stalled, 50), withRequestTimeout(b.transport, 50)],
    { stickyKey: "t6" }
  );

  const result = await transport(request("getBalance"));

  assert.deepEqual(result, { ok: true });
  assert.equal(stalledCalls, 1);
  assert.equal(b.calls, 1);
});
