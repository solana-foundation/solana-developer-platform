import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import {
  type Base64EncodedWireTransaction,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
} from "@solana/kit";
import { createClusterRpc } from "./factory";
import { runInClusterScope } from "./scope";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS } from "./solana";
import type { ManagedRpcEnv } from "./types";

type Answer = { kind: "result" } | { kind: "jsonRpcError"; code: number } | { kind: "fetchFailed" };

type GenesisAnswer = { kind: "hash"; genesisHash: string } | { kind: "fetchFailed" };

type Endpoint = { genesis: GenesisAnswer; answer: Answer };

type RpcCall = { url: string; method: string };

type JsonRpcBody = { result: unknown } | { error: { code: number; message: string } };

const SLOT = 7;

const SERVES_DEVNET: Endpoint = {
  genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
  answer: { kind: "result" },
};
const SERVES_MAINNET: Endpoint = {
  genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] },
  answer: { kind: "result" },
};
const DEVNET_FETCH_FAILS: Endpoint = {
  genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
  answer: { kind: "fetchFailed" },
};
const GENESIS_PROBE_FETCH_FAILS: Endpoint = {
  genesis: { kind: "fetchFailed" },
  answer: { kind: "result" },
};

type ScopeFacts = Parameters<typeof runInClusterScope>[0];

const SANDBOX: ScopeFacts = { projectId: "proj_factory_sandbox", environment: "sandbox" };
const PRODUCTION: ScopeFacts = {
  projectId: "proj_factory_production",
  environment: "production",
};

const MANAGED_POOL_ENV_KEY = /^SOLANA_RPC_[A-Z]+_(?:DEVNET|MAINNET)_API_KEY_URL$/;

const originalFetch = globalThis.fetch;

let ambientPool: NodeJS.ProcessEnv = {};

function clearManagedPool(): void {
  for (const envKey of Object.keys(process.env)) {
    if (MANAGED_POOL_ENV_KEY.test(envKey)) delete process.env[envKey];
  }
}

function configurePool(pool: ManagedRpcEnv): void {
  Object.assign(process.env, pool);
}

function devnetJsonRpcError(code: number): Endpoint {
  return {
    genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
    answer: { kind: "jsonRpcError", code },
  };
}

function readRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): { url: string; id: unknown; method: string; signal: AbortSignal | null | undefined } {
  assert.ok(typeof input === "string");
  assert.ok(init !== undefined && typeof init.body === "string");
  const payload: unknown = JSON.parse(init.body);
  assert.ok(
    typeof payload === "object" &&
      payload !== null &&
      "id" in payload &&
      "method" in payload &&
      typeof payload.method === "string"
  );
  return { url: input, id: payload.id, method: payload.method, signal: init.signal };
}

function respond(id: unknown, body: JsonRpcBody): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
}

function stubEndpoints(endpoints: Readonly<Record<string, Endpoint>>): RpcCall[] {
  const calls: RpcCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    const endpoint = endpoints[request.url];
    if (request.method === "getGenesisHash") {
      if (endpoint.genesis.kind === "fetchFailed") throw new TypeError("fetch failed");
      return respond(request.id, { result: endpoint.genesis.genesisHash });
    }
    if (endpoint.answer.kind === "fetchFailed") throw new TypeError("fetch failed");
    if (endpoint.answer.kind === "jsonRpcError") {
      return respond(request.id, {
        error: { code: endpoint.answer.code, message: "Node cannot serve this request yet" },
      });
    }
    return respond(request.id, { result: SLOT });
  };
  return calls;
}

function stubHeldDevnetGenesisProbe(): {
  calls: RpcCall[];
  probeSignals: AbortSignal[];
  releaseProbe: () => void;
} {
  const calls: RpcCall[] = [];
  const probeSignals: AbortSignal[] = [];
  const probeReleases: Array<() => void> = [];
  const probeReleased = new Promise<void>((resolve) => {
    probeReleases.push(resolve);
  });
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    if (request.method !== "getGenesisHash") return respond(request.id, { result: SLOT });
    assert.ok(request.signal instanceof AbortSignal);
    probeSignals.push(request.signal);
    await probeReleased;
    return respond(request.id, { result: GENESIS_HASH_BY_CLUSTER.devnet });
  };
  return {
    calls,
    probeSignals,
    releaseProbe: () => {
      for (const release of probeReleases) release();
    },
  };
}

function stubStalledDevnetRead(stalledUrl: string): {
  calls: RpcCall[];
  readStalled: Promise<void>;
} {
  const calls: RpcCall[] = [];
  const stallStarts: Array<() => void> = [];
  const readStalled = new Promise<void>((resolve) => {
    stallStarts.push(resolve);
  });
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    if (request.method === "getGenesisHash") {
      return respond(request.id, { result: GENESIS_HASH_BY_CLUSTER.devnet });
    }
    if (request.url !== stalledUrl) return respond(request.id, { result: SLOT });
    const { signal } = request;
    assert.ok(signal instanceof AbortSignal);
    for (const markStalled of stallStarts) markStalled();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { calls, readStalled };
}

function genesisProbe(url: string): RpcCall {
  return { url, method: "getGenesisHash" };
}

function slotRead(url: string): RpcCall {
  return { url, method: "getSlot" };
}

describe("createClusterRpc", () => {
  beforeEach(() => {
    ambientPool = Object.fromEntries(
      Object.entries(process.env).filter(([envKey]) => MANAGED_POOL_ENV_KEY.test(envKey))
    );
    clearManagedPool();
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    clearManagedPool();
    Object.assign(process.env, ambientPool);
  });

  it("refuses to build a client outside a cluster scope", () => {
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet-unscoped.example.test" });

    assert.throws(() => createClusterRpc(), {
      name: "SdpRpcError",
      message: "No cluster scope is open for this work",
      code: "CLUSTER_SCOPE_MISSING",
      statusCode: 500,
    });
  });

  it("sends a sandbox scope only to the devnet pool and a production scope only to mainnet", async () => {
    const devnet = "https://devnet-routing.example.test";
    const mainnet = "https://mainnet-routing.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: mainnet,
    });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET, [mainnet]: SERVES_MAINNET });

    assert.equal(await runInClusterScope(SANDBOX, createClusterRpc).getSlot().send(), BigInt(SLOT));
    assert.deepEqual(calls, [genesisProbe(devnet), slotRead(devnet)]);

    assert.equal(
      await runInClusterScope(PRODUCTION, createClusterRpc).getSlot().send(),
      BigInt(SLOT)
    );
    assert.deepEqual(calls, [
      genesisProbe(devnet),
      slotRead(devnet),
      genesisProbe(mainnet),
      slotRead(mainnet),
    ]);
  });

  it("shares one client per cluster and pool", () => {
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet-memo.example.test",
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "https://mainnet-memo.example.test",
    });
    const sandboxRpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(
      runInClusterScope(
        { projectId: "proj_factory_other", environment: "sandbox" },
        createClusterRpc
      ),
      sandboxRpc
    );
    assert.notEqual(runInClusterScope(PRODUCTION, createClusterRpc), sandboxRpc);
  });

  it("refuses a scope whose cluster has no configured endpoint when the client is requested", () => {
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet-only.example.test" });

    assert.throws(() => runInClusterScope(PRODUCTION, createClusterRpc), {
      name: "SdpRpcError",
      message: "No RPC endpoint is configured for mainnet-beta",
      code: "RPC_NOT_CONFIGURED",
      statusCode: 503,
      details: { cluster: "mainnet-beta" },
    });
  });

  it("rejects a cluster mismatch without failing over", async () => {
    const wrongCluster = "https://devnet-mismatch-a.example.test";
    const healthy = "https://devnet-mismatch-b.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: wrongCluster,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const calls = stubEndpoints({ [wrongCluster]: SERVES_MAINNET, [healthy]: SERVES_DEVNET });

    await assert.rejects(runInClusterScope(SANDBOX, createClusterRpc).getSlot().send(), {
      name: "SdpRpcError",
      message: "An RPC endpoint configured for devnet serves a different cluster",
      code: "RPC_CLUSTER_MISMATCH",
      statusCode: 500,
      details: { cluster: "devnet", genesisHash: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] },
    });
    assert.deepEqual(calls, [genesisProbe(wrongCluster)]);
  });

  it("proves an endpoint URL configured for both clusters separately per cluster", async () => {
    const url = "https://both-clusters.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: url,
    });
    const calls = stubEndpoints({ [url]: SERVES_DEVNET });

    assert.equal(await runInClusterScope(SANDBOX, createClusterRpc).getSlot().send(), BigInt(SLOT));
    await assert.rejects(runInClusterScope(PRODUCTION, createClusterRpc).getSlot().send(), {
      name: "SdpRpcError",
      message: "An RPC endpoint configured for mainnet-beta serves a different cluster",
      code: "RPC_CLUSTER_MISMATCH",
      statusCode: 500,
      details: { cluster: "mainnet-beta", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
    });
    assert.deepEqual(calls, [genesisProbe(url), slotRead(url), genesisProbe(url)]);
  });

  it("trusts a genesis proof for 30 seconds, then re-proves", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const url = "https://devnet-ttl.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url });
    const calls = stubEndpoints({ [url]: SERVES_DEVNET });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    mock.timers.tick(29_999);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(calls, [genesisProbe(url), slotRead(url), slotRead(url)]);

    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(calls, [
      genesisProbe(url),
      slotRead(url),
      slotRead(url),
      genesisProbe(url),
      slotRead(url),
    ]);
  });

  it("rejects an aborted caller while the shared genesis probe is held and still answers the other caller", async () => {
    const url = "https://devnet-abort.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url });
    const held = stubHeldDevnetGenesisProbe();
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);
    const caller = new AbortController();
    const callerDeadline = new Error("caller deadline passed");

    const abortedOutcome = rpc
      .getSlot()
      .send({ abortSignal: caller.signal })
      .then(
        () => "answered",
        (error: unknown) => error
      );
    const read = rpc.getBlockHeight().send();
    await nextTurn();
    assert.deepEqual(held.calls, [genesisProbe(url)]);

    caller.abort(callerDeadline);

    assert.equal(
      await Promise.race([abortedOutcome, nextTurn().then(() => "still waiting on the probe")]),
      callerDeadline
    );
    assert.deepEqual(
      held.probeSignals.map((probeSignal) => probeSignal.aborted),
      [false]
    );

    held.releaseProbe();
    assert.equal(await read, BigInt(SLOT));
    assert.deepEqual(held.calls, [genesisProbe(url), { url, method: "getBlockHeight" }]);
  });

  it("shares one genesis probe between concurrent first requests to an endpoint", async () => {
    const url = "https://devnet-shared-probe.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url });
    const held = stubHeldDevnetGenesisProbe();
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    const slot = rpc.getSlot().send();
    await nextTurn();
    const blockHeight = rpc.getBlockHeight().send();
    await nextTurn();
    assert.deepEqual(held.calls, [genesisProbe(url)]);

    held.releaseProbe();
    assert.deepEqual(await Promise.all([slot, blockHeight]), [BigInt(SLOT), BigInt(SLOT)]);
    assert.deepEqual(held.calls, [
      genesisProbe(url),
      slotRead(url),
      { url, method: "getBlockHeight" },
    ]);
  });

  it("fails over on a can't-serve-yet body and surfaces the last endpoint's as kit's error", async () => {
    const behind = "https://devnet-behind.example.test";
    const unhealthy = "https://devnet-unhealthy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: behind,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: unhealthy,
    });
    const calls = stubEndpoints({
      [behind]: devnetJsonRpcError(
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED
      ),
      [unhealthy]: devnetJsonRpcError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY),
    });

    await assert.rejects(runInClusterScope(SANDBOX, createClusterRpc).getSlot().send(), (error) =>
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)
    );
    assert.deepEqual(calls, [
      genesisProbe(behind),
      slotRead(behind),
      genesisProbe(unhealthy),
      slotRead(unhealthy),
    ]);
  });

  it("fails over on a transport failure and skips the failed endpoint while it cools down", async () => {
    const down = "https://devnet-down.example.test";
    const healthy = "https://devnet-healthy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: down,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const calls = stubEndpoints({ [down]: DEVNET_FETCH_FAILS, [healthy]: SERVES_DEVNET });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));

    assert.deepEqual(calls, [
      genesisProbe(down),
      slotRead(down),
      genesisProbe(healthy),
      slotRead(healthy),
      slotRead(healthy),
    ]);
  });

  it("keeps the attempt deadline under a caller's own abort signal and fails a stalled endpoint over", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = "https://devnet-stalled.example.test";
    const healthy = "https://devnet-after-stall.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: stalled,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const stall = stubStalledDevnetRead(stalled);
    const caller = new AbortController();

    const slot = runInClusterScope(SANDBOX, createClusterRpc)
      .getSlot()
      .send({ abortSignal: caller.signal });
    await stall.readStalled;
    mock.timers.tick(DEFAULT_RPC_REQUEST_TIMEOUT_MS);

    assert.equal(await slot, BigInt(SLOT));
    assert.deepEqual(stall.calls, [
      genesisProbe(stalled),
      slotRead(stalled),
      genesisProbe(healthy),
      slotRead(healthy),
    ]);
  });

  it("returns to the preferred endpoint once its 30-second cooldown ends", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const preferred = "https://devnet-preferred.example.test";
    const fallback = "https://devnet-fallback.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: preferred,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: fallback,
    });
    const outageCalls = stubEndpoints({
      [preferred]: DEVNET_FETCH_FAILS,
      [fallback]: SERVES_DEVNET,
    });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(outageCalls, [
      genesisProbe(preferred),
      slotRead(preferred),
      genesisProbe(fallback),
      slotRead(fallback),
    ]);

    const recoveredCalls = stubEndpoints({ [preferred]: SERVES_DEVNET, [fallback]: SERVES_DEVNET });
    mock.timers.tick(29_999);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(recoveredCalls, [slotRead(fallback)]);

    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(recoveredCalls, [
      slotRead(fallback),
      genesisProbe(preferred),
      slotRead(preferred),
    ]);
  });

  it("stops failing over once the caller aborts", async () => {
    const stalled = "https://devnet-abandoned.example.test";
    const healthy = "https://devnet-never-asked.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: stalled,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const stall = stubStalledDevnetRead(stalled);
    const caller = new AbortController();
    const callerTimeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );

    const slot = runInClusterScope(SANDBOX, createClusterRpc)
      .getSlot()
      .send({ abortSignal: caller.signal });
    await stall.readStalled;
    caller.abort(callerTimeout);

    await assert.rejects(slot, (error: unknown) => error === callerTimeout);
    await nextTurn();
    assert.deepEqual(stall.calls, [genesisProbe(stalled), slotRead(stalled)]);
  });

  it("never fails sendTransaction over to another endpoint", async () => {
    const down = "https://devnet-send-down.example.test";
    const healthy = "https://devnet-send-healthy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: down,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const calls = stubEndpoints({ [down]: DEVNET_FETCH_FAILS, [healthy]: SERVES_DEVNET });

    await assert.rejects(
      runInClusterScope(SANDBOX, createClusterRpc)
        .sendTransaction("AQ==" as Base64EncodedWireTransaction, { encoding: "base64" })
        .send(),
      { name: "TypeError", message: "fetch failed" }
    );
    assert.deepEqual(calls, [genesisProbe(down), { url: down, method: "sendTransaction" }]);
  });

  it("fails a cold sendTransaction over when its first endpoint's genesis probe fails transiently", async () => {
    const unproven = "https://devnet-send-unproven.example.test";
    const proven = "https://devnet-send-proven.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: unproven,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: proven,
    });
    const calls = stubEndpoints({ [unproven]: GENESIS_PROBE_FETCH_FAILS, [proven]: SERVES_DEVNET });

    await runInClusterScope(SANDBOX, createClusterRpc)
      .sendTransaction("AQ==" as Base64EncodedWireTransaction, { encoding: "base64" })
      .send();

    assert.deepEqual(calls, [
      genesisProbe(unproven),
      genesisProbe(proven),
      { url: proven, method: "sendTransaction" },
    ]);
  });
});
