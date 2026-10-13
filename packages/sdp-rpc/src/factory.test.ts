import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import {
  address,
  type Base64EncodedWireTransaction,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
} from "@solana/kit";
import {
  createClusterBoundedRpc,
  createClusterDasRpc,
  createClusterJsonRpcFetch,
  createClusterReadRpc,
  createClusterRpc,
  type DasGetAssetBatchParams,
  type DasSearchAssetsParams,
  type DasSearchAssetsResult,
} from "./factory";
import { withMinimumRpcSlot } from "./read-context";
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

function stubHeldSlotReads(genesisHashByUrl: Readonly<Record<string, string>>): {
  calls: RpcCall[];
  releaseSlotReads: () => void;
} {
  const calls: RpcCall[] = [];
  const slotReadReleases: Array<() => void> = [];
  const slotReadsReleased = new Promise<void>((resolve) => {
    slotReadReleases.push(resolve);
  });
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    if (request.method === "getGenesisHash") {
      return respond(request.id, { result: genesisHashByUrl[request.url] });
    }
    await slotReadsReleased;
    return respond(request.id, { result: SLOT });
  };
  return {
    calls,
    releaseSlotReads: () => {
      for (const release of slotReadReleases) release();
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

type DasEndpointCall = { url: string; method: string; params: unknown };

const DAS_SEARCH_PARAMS: DasSearchAssetsParams = {
  ownerAddress: "das_owner_factory_test",
  tokenType: "fungible",
  page: 1,
  limit: 100,
  displayOptions: { showFungible: true },
};

const DAS_ASSET_BATCH_PARAMS: DasGetAssetBatchParams = {
  ids: ["das_mint_factory_test"],
  displayOptions: { showFungible: true },
};

const DAS_SEARCH_RESULT: DasSearchAssetsResult = {
  items: [
    {
      id: "das_mint_factory_test",
      token_info: { amount: 3_000_000, decimals: 6, uiAmountString: "3" },
    },
  ],
};

function stubDasEndpoint(genesisHash: string, body: JsonRpcBody): DasEndpointCall[] {
  const calls: DasEndpointCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    assert.ok(init !== undefined && typeof init.body === "string");
    const payload: unknown = JSON.parse(init.body);
    assert.ok(typeof payload === "object" && payload !== null && "params" in payload);
    calls.push({ url: request.url, method: request.method, params: payload.params });
    if (request.method === "getGenesisHash") return respond(request.id, { result: genesisHash });
    return respond(request.id, body);
  };
  return calls;
}

function isolateManagedPool(): void {
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
}

describe("createClusterRpc", () => {
  isolateManagedPool();

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

describe("createClusterBoundedRpc", () => {
  isolateManagedPool();

  it("rejects a read that outlives the client's deadline as a timeout", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = "https://devnet-bounded-stall.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: stalled });
    const stall = stubStalledDevnetRead(stalled);
    const timeoutMs = 1_000;

    const slot = runInClusterScope(SANDBOX, () => createClusterBoundedRpc({ timeoutMs }))
      .getSlot()
      .send();
    await stall.readStalled;
    mock.timers.tick(timeoutMs);

    await assert.rejects(slot, {
      name: "SdpRpcError",
      code: "SOLANA_RPC_ERROR",
      message: `RPC request timed out after ${timeoutMs}ms`,
      details: { timedOut: true },
    });
    assert.deepEqual(stall.calls, [genesisProbe(stalled), slotRead(stalled)]);
  });

  it("sends a read with the caller's minimum slot and refuses an answer from behind it", async () => {
    const url = "https://devnet-bounded-minimum-slot.example.test";
    const account = "11111111111111111111111111111111";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url });
    const sentParams: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const request = readRequest(input, init);
      if (request.method === "getGenesisHash") {
        return respond(request.id, { result: GENESIS_HASH_BY_CLUSTER.devnet });
      }
      assert.ok(init !== undefined && typeof init.body === "string");
      const payload: unknown = JSON.parse(init.body);
      assert.ok(typeof payload === "object" && payload !== null && "params" in payload);
      sentParams.push(payload.params);
      return respond(request.id, { result: { context: { slot: 99 }, value: [null] } });
    };
    const rpc = runInClusterScope(SANDBOX, () =>
      createClusterBoundedRpc({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    await assert.rejects(
      withMinimumRpcSlot(100, () =>
        rpc.getMultipleAccounts([address(account)], { encoding: "base64" }).send()
      ),
      /behind/
    );
    assert.deepEqual(sentParams, [
      [[account], { commitment: "confirmed", encoding: "base64", minContextSlot: 100 }],
    ]);
  });
});

describe("createClusterReadRpc", () => {
  isolateManagedPool();

  it("sends concurrent identical reads in one scope once and never shares them across clusters", async () => {
    const devnet = "https://devnet-read-sharing.example.test";
    const mainnet = "https://mainnet-read-sharing.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: mainnet,
    });
    const held = stubHeldSlotReads({
      [devnet]: GENESIS_HASH_BY_CLUSTER.devnet,
      [mainnet]: GENESIS_HASH_BY_CLUSTER["mainnet-beta"],
    });
    const sandboxReads = runInClusterScope(SANDBOX, () =>
      createClusterReadRpc({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );
    const productionReads = runInClusterScope(PRODUCTION, () =>
      createClusterReadRpc({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    const first = sandboxReads.getSlot().send();
    await nextTurn();
    const joined = sandboxReads.getSlot().send();
    const otherCluster = productionReads.getSlot().send();
    await nextTurn();
    held.releaseSlotReads();

    assert.deepEqual(await Promise.all([first, joined, otherCluster]), [
      BigInt(SLOT),
      BigInt(SLOT),
      BigInt(SLOT),
    ]);
    assert.deepEqual(
      held.calls.filter((call) => call.method === "getSlot"),
      [slotRead(devnet), slotRead(mainnet)]
    );
  });
});

describe("createClusterDasRpc", () => {
  isolateManagedPool();

  it("is null when the scope's cluster has no Helius URL, even when the other cluster has one", () => {
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet-das-none.example.test",
      SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: "https://mainnet-das-only.example.test",
    });

    assert.equal(runInClusterScope(SANDBOX, createClusterDasRpc), null);
  });

  it("sends its argument as the named params object and returns the result as Helius sent it", async () => {
    const url = "https://devnet-das-params.example.test";
    configurePool({ SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: url });
    const calls = stubDasEndpoint(GENESIS_HASH_BY_CLUSTER.devnet, { result: DAS_SEARCH_RESULT });
    const dasRpc = runInClusterScope(SANDBOX, createClusterDasRpc);
    assert.ok(dasRpc !== null);

    assert.deepEqual(await dasRpc.searchAssets(DAS_SEARCH_PARAMS).send(), DAS_SEARCH_RESULT);
    assert.deepEqual(calls, [
      { url, method: "getGenesisHash", params: [] },
      { url, method: "searchAssets", params: DAS_SEARCH_PARAMS },
    ]);
  });

  it("raises a JSON-RPC error body as kit's SolanaError", async () => {
    const url = "https://devnet-das-error.example.test";
    configurePool({ SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: url });
    stubDasEndpoint(GENESIS_HASH_BY_CLUSTER.devnet, {
      error: { code: SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, message: "Invalid params" },
    });
    const dasRpc = runInClusterScope(SANDBOX, createClusterDasRpc);
    assert.ok(dasRpc !== null);

    await assert.rejects(dasRpc.getAssetBatch(DAS_ASSET_BATCH_PARAMS).send(), (error) =>
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS)
    );
  });

  it("refuses a Helius URL that serves another cluster before sending the DAS call", async () => {
    const url = "https://devnet-das-mismatch.example.test";
    configurePool({ SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: url });
    const calls = stubDasEndpoint(GENESIS_HASH_BY_CLUSTER["mainnet-beta"], {
      result: DAS_SEARCH_RESULT,
    });
    const dasRpc = runInClusterScope(SANDBOX, createClusterDasRpc);
    assert.ok(dasRpc !== null);

    await assert.rejects(dasRpc.searchAssets(DAS_SEARCH_PARAMS).send(), {
      name: "SdpRpcError",
      message: "An RPC endpoint configured for devnet serves a different cluster",
      code: "RPC_CLUSTER_MISMATCH",
      statusCode: 500,
      details: { cluster: "devnet", genesisHash: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] },
    });
    assert.deepEqual(calls, [{ url, method: "getGenesisHash", params: [] }]);
  });

  it("builds a new DAS client once the cluster's Helius URL changes", () => {
    configurePool({
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://devnet-das-key-a.example.test",
    });
    const original = runInClusterScope(SANDBOX, createClusterDasRpc);
    assert.ok(original !== null);
    assert.equal(
      runInClusterScope(
        { projectId: "proj_factory_other", environment: "sandbox" },
        createClusterDasRpc
      ),
      original
    );

    configurePool({
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://devnet-das-key-b.example.test",
    });

    assert.notEqual(runInClusterScope(SANDBOX, createClusterDasRpc), original);
  });
});

interface JsonWithBigIntsCodec {
  parse: (json: string) => unknown;
  stringify: (value: unknown) => string;
}

function kitJsonWithBigIntsCodec(): JsonWithBigIntsCodec {
  const requireFromRpc = createRequire(import.meta.url);
  const requireFromKit = createRequire(requireFromRpc.resolve("@solana/kit"));
  const specTypes: unknown = requireFromKit("@solana/rpc-spec-types");
  assert.ok(
    typeof specTypes === "object" &&
      specTypes !== null &&
      "parseJsonWithBigInts" in specTypes &&
      typeof specTypes.parseJsonWithBigInts === "function" &&
      "stringifyJsonWithBigInts" in specTypes &&
      typeof specTypes.stringifyJsonWithBigInts === "function"
  );
  const kitParse = specTypes.parseJsonWithBigInts;
  const kitStringify = specTypes.stringifyJsonWithBigInts;
  return {
    parse: (json) => {
      const value: unknown = kitParse(json);
      return value;
    },
    stringify: (value) => {
      const text: unknown = kitStringify(value);
      assert.ok(typeof text === "string");
      return text;
    },
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, choices: readonly T[]): T {
  return choices[Math.floor(random() * choices.length)];
}

const INTEGER_LITERALS = [
  "0",
  "-0",
  "1",
  "-1",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740993",
  "9223372036854775807",
  "-9223372036854775808",
  "18446744073709551615",
  "340282366920938463463374607431768211455",
  "1E+2",
  "7e3",
] as const;

const FLOAT_LITERALS = [
  "1.5",
  "-0.25",
  "3.0",
  "1e-7",
  "6.02e23",
  "2.5E-3",
  "-1.7976931348623157e308",
] as const;

const STRING_VALUES = [
  "",
  "9007199254740993",
  "-12",
  "1e5",
  '{"$n":"5"}',
  '"quoted"',
  "back\\slash",
  "é",
  "💥",
  "\u2028",
  "naïve façade",
  "$n",
  "0x1f",
] as const;

const OBJECT_KEYS = [
  "slot",
  "lamports",
  "",
  "ключ",
  "💥",
  "9007199254740993",
  "a b",
  '"q"',
] as const;

const WHITESPACE = ["", " ", "\n", "\t "] as const;

function randomIntegerLiteral(random: () => number): string {
  const length = 1 + Math.floor(random() * 40);
  let digits = String(1 + Math.floor(random() * 9));
  while (digits.length < length) digits += String(Math.floor(random() * 10));
  return random() < 0.5 ? `-${digits}` : digits;
}

function jsonScalar(random: () => number): string {
  const kind = pick(random, ["integer", "random-integer", "float", "string", "literal"] as const);
  if (kind === "integer") return pick(random, INTEGER_LITERALS);
  if (kind === "random-integer") return randomIntegerLiteral(random);
  if (kind === "float") return pick(random, FLOAT_LITERALS);
  if (kind === "string") return JSON.stringify(pick(random, STRING_VALUES));
  return pick(random, ["true", "false", "null"] as const);
}

function jsonDocument(random: () => number, depth: number): string {
  const kind = depth === 0 ? "scalar" : pick(random, ["scalar", "array", "object"] as const);
  const space = () => pick(random, WHITESPACE);
  const memberCount = Math.floor(random() * 4);
  if (kind === "array") {
    const elements = Array.from({ length: memberCount }, () => jsonDocument(random, depth - 1));
    return `[${space()}${elements.join(`,${space()}`)}${space()}]`;
  }
  if (kind === "object") {
    const members = Array.from(
      { length: memberCount },
      () =>
        `${JSON.stringify(pick(random, OBJECT_KEYS))}${space()}:${space()}${jsonDocument(random, depth - 1)}`
    );
    return `{${space()}${members.join(`,${space()}`)}${space()}}`;
  }
  return jsonScalar(random);
}

function stubRawJsonRpc(genesisHash: string, answer: () => string): RpcCall[] {
  const calls: RpcCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    if (request.method === "getGenesisHash") return respond(request.id, { result: genesisHash });
    return new Response(answer());
  };
  return calls;
}

function jsonRpcInit(method: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: ["11111111111111111111111111111111", { encoding: "base64" }],
    }),
  };
}

describe("createClusterJsonRpcFetch", () => {
  isolateManagedPool();

  it("sends a request for any URL to the scope cluster's pool endpoint", async () => {
    const devnet = "https://devnet-json-rpc-routing.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET });
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    const response = await jsonRpcFetch(
      "https://door.invalid/never-dialed",
      jsonRpcInit("getSlot")
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: SLOT });
    assert.deepEqual(calls, [genesisProbe(devnet), slotRead(devnet)]);
  });

  it("sends a request integer beyond 2^53 to the pool endpoint exactly and keeps the id a plain number", async () => {
    const devnet = "https://devnet-json-rpc-request-precision.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const sentBodies: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = readRequest(input, init);
      if (request.method === "getGenesisHash") {
        return respond(request.id, { result: GENESIS_HASH_BY_CLUSTER.devnet });
      }
      assert.ok(init !== undefined && typeof init.body === "string");
      sentBodies.push(init.body);
      return respond(request.id, { result: null });
    };
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    await jsonRpcFetch("https://door.invalid", {
      method: "POST",
      body: '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[9007199254740993,{"commitment":"finalized"}]}',
    });

    assert.deepEqual(sentBodies, [
      '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[9007199254740993,{"commitment":"finalized"}]}',
    ]);
  });

  it("keeps a sandbox scope on the devnet pool and a production scope on mainnet", async () => {
    const devnet = "https://devnet-json-rpc-clusters.example.test";
    const mainnet = "https://mainnet-json-rpc-clusters.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: mainnet,
    });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET, [mainnet]: SERVES_MAINNET });
    const options = { timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS };
    const sandboxFetch = runInClusterScope(SANDBOX, () => createClusterJsonRpcFetch(options));
    const productionFetch = runInClusterScope(PRODUCTION, () => createClusterJsonRpcFetch(options));

    assert.notEqual(sandboxFetch, productionFetch);
    await sandboxFetch("https://door.invalid", jsonRpcInit("getSlot"));
    await productionFetch("https://door.invalid", jsonRpcInit("getSlot"));

    assert.deepEqual(calls, [
      genesisProbe(devnet),
      slotRead(devnet),
      genesisProbe(mainnet),
      slotRead(mainnet),
    ]);
  });

  it("returns integers beyond 2^53 exactly as the endpoint sent them", async () => {
    const devnet = "https://devnet-json-rpc-precision.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const answered =
      '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":9007199254740993},' +
      '"value":{"lamports":18446744073709551615,"rentEpoch":-9223372036854775808}}}';
    stubRawJsonRpc(GENESIS_HASH_BY_CLUSTER.devnet, () => answered);
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    const response = await jsonRpcFetch("https://door.invalid", jsonRpcInit("getAccountInfo"));

    assert.equal(await response.text(), answered);
  });

  it("re-serializes every decoded response exactly as kit's own stringifyJsonWithBigInts", async () => {
    const devnet = "https://devnet-json-rpc-differential.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const kit = kitJsonWithBigIntsCodec();
    const random = seededRandom(1_881);
    const documents = Array.from({ length: 400 }, () => jsonDocument(random, 4));
    let answered = "";
    stubRawJsonRpc(GENESIS_HASH_BY_CLUSTER.devnet, () => answered);
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    for (const document of documents) {
      answered = `{"jsonrpc":"2.0","id":1,"result":${document}}`;
      const response = await jsonRpcFetch("https://door.invalid", jsonRpcInit("getAccountInfo"));
      assert.equal(await response.text(), kit.stringify(kit.parse(answered)), answered);
    }
    assert.ok(documents.some((document) => document.includes("18446744073709551615")));
  });

  it("returns a genuine $n object in a response kit decodes as plain JSON exactly as the endpoint sent it", async () => {
    const devnet = "https://devnet-json-rpc-value-object.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const answered =
      '{"jsonrpc":"2.0","id":1,"result":{"interface":{"$n":"5"},"supply":{"$n":"-12"},"slot":7}}';
    stubRawJsonRpc(GENESIS_HASH_BY_CLUSTER.devnet, () => answered);
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    const response = await jsonRpcFetch("https://door.invalid", jsonRpcInit("getAsset"));

    assert.equal(await response.text(), answered);
  });

  it("refuses a JSON-RPC batch before any request reaches the pool", async () => {
    const devnet = "https://devnet-json-rpc-batch.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET });
    const jsonRpcFetch = runInClusterScope(SANDBOX, () =>
      createClusterJsonRpcFetch({ timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
    );

    await assert.rejects(
      jsonRpcFetch("https://door.invalid", {
        method: "POST",
        body: '[{"jsonrpc":"2.0","id":1,"method":"getSlot"},{"jsonrpc":"2.0","id":2,"method":"getSlot"}]',
      }),
      {
        name: "TypeError",
        message: "The cluster JSON-RPC fetch sends one JSON-RPC request at a time",
      }
    );
    assert.deepEqual(calls, []);
  });
});
