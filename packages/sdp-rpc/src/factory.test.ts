import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  type GetSlotApi,
  getBase64EncodedWireTransaction,
  isSolanaError,
  lamports,
  pipe,
  type RequestAirdropApi,
  type Rpc,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  createClusterHistoryRpc,
  createClusterRpc,
  createKoraUpstreamRpc,
  earnClusterEndpointUrls,
  proveEarnClusterEndpoint,
} from "./factory";
import { runInClusterScope } from "./scope";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS } from "./solana";
import { type RpcTelemetryEvent, setRpcTelemetrySink } from "./telemetry";
import type { ManagedRpcEnv } from "./types";

type Answer =
  | { kind: "result" }
  | { kind: "jsonRpcError"; code: number }
  | { kind: "httpStatus"; status: number }
  | { kind: "fetchFailed" };

type GenesisAnswer = { kind: "hash"; genesisHash: string } | { kind: "fetchFailed" };

type Endpoint = { genesis: GenesisAnswer; answer: Answer };

type RpcCall = { url: string; method: string };

type JsonRpcBody = { result: unknown } | { error: { code: number; message: string } };

const SLOT = 7;

const AIRDROP_RECIPIENT = address("11111111111111111111111111111111");

const WIRE_TRANSACTION = getBase64EncodedWireTransaction(
  compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) =>
        setTransactionMessageFeePayer(address("11111111111111111111111111111111"), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n },
          message
        )
    )
  )
);

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

const RPC_ENV_KEY =
  /^(?:SOLANA_RPC_[A-Z]+_(?:DEVNET|MAINNET)_API_KEY_URL|KORA_(?:DEVNET|MAINNET)_RPC_URL)$/;

const originalFetch = globalThis.fetch;

let ambientRpcEnv: NodeJS.ProcessEnv = {};

function clearRpcEnv(): void {
  for (const envKey of Object.keys(process.env)) {
    if (RPC_ENV_KEY.test(envKey)) delete process.env[envKey];
  }
}

function configurePool(pool: ManagedRpcEnv): void {
  Object.assign(process.env, pool);
}

function configureKoraUpstreams(
  upstreams: Partial<Record<"KORA_DEVNET_RPC_URL" | "KORA_MAINNET_RPC_URL", string>>
): void {
  Object.assign(process.env, upstreams);
}

function devnetJsonRpcError(code: number): Endpoint {
  return {
    genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
    answer: { kind: "jsonRpcError", code },
  };
}

function devnetHttpStatus(status: number): Endpoint {
  return {
    genesis: { kind: "hash", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
    answer: { kind: "httpStatus", status },
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
    if (endpoint.answer.kind === "httpStatus") {
      return new Response("Too Many Requests", { status: endpoint.answer.status });
    }
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

function airdropRequest(url: string): RpcCall {
  return { url, method: "requestAirdrop" };
}

function isolateRpcEnv(): void {
  ambientRpcEnv = Object.fromEntries(
    Object.entries(process.env).filter(([envKey]) => RPC_ENV_KEY.test(envKey))
  );
  clearRpcEnv();
}

function restoreRpcEnv(): void {
  setRpcTelemetrySink(null);
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  clearRpcEnv();
  Object.assign(process.env, ambientRpcEnv);
}

describe("createClusterRpc", () => {
  beforeEach(isolateRpcEnv);

  afterEach(restoreRpcEnv);

  it("records each provider attempt, 429 failover and cooldown without logging URLs", async () => {
    const throttled = "https://devnet-throttled.example.test/?api-key=private";
    const healthy = "https://devnet-healthy.example.test/?api-key=private";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: throttled,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    stubEndpoints({ [throttled]: devnetHttpStatus(429), [healthy]: SERVES_DEVNET });
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));

    assert.equal(await runInClusterScope(SANDBOX, createClusterRpc).getSlot().send(), BigInt(SLOT));

    assert.deepEqual(
      events.map(({ event, provider, outcome, status_code }) => ({
        event,
        provider,
        outcome,
        status_code,
      })),
      [
        { event: "sdp_rpc_attempt", provider: "triton", outcome: "failed", status_code: 429 },
        {
          event: "sdp_rpc_cooldown",
          provider: "triton",
          outcome: undefined,
          status_code: undefined,
        },
        {
          event: "sdp_rpc_failover",
          provider: "triton",
          outcome: undefined,
          status_code: undefined,
        },
        {
          event: "sdp_rpc_attempt",
          provider: "helius",
          outcome: "succeeded",
          status_code: undefined,
        },
      ]
    );
    assert.ok(events.every((event) => event.cluster === "devnet" && event.method === "getSlot"));
    assert.ok(
      events.every(
        (event) => typeof event.duration_ms === "number" || event.event !== "sdp_rpc_attempt"
      )
    );
    assert.ok(!JSON.stringify(events).includes("private"));
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
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));

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
    assert.deepEqual(
      events.map((event) => event.outcome),
      ["aborted", "succeeded"]
    );
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
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));

    const slot = runInClusterScope(SANDBOX, createClusterRpc)
      .getSlot()
      .send({ abortSignal: caller.signal });
    await stall.readStalled;
    mock.timers.tick(DEFAULT_RPC_REQUEST_TIMEOUT_MS);

    assert.equal(await slot, BigInt(SLOT));
    assert.deepEqual(
      events.filter((event) => event.event === "sdp_rpc_attempt").map((event) => event.outcome),
      ["failed", "succeeded"]
    );
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

  it("fails a read behind the caller's slot over without cooling the endpoint down", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const preferred = "https://devnet-behind-preferred.example.test";
    const fallback = "https://devnet-behind-fallback.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: preferred,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: fallback,
    });
    const behindCalls = stubEndpoints({
      [preferred]: devnetJsonRpcError(
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED
      ),
      [fallback]: SERVES_DEVNET,
    });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(behindCalls, [
      genesisProbe(preferred),
      slotRead(preferred),
      genesisProbe(fallback),
      slotRead(fallback),
    ]);

    const caughtUpCalls = stubEndpoints({ [preferred]: SERVES_DEVNET, [fallback]: SERVES_DEVNET });
    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    await rpc.sendTransaction(WIRE_TRANSACTION, { encoding: "base64" }).send();
    assert.deepEqual(caughtUpCalls, [
      slotRead(preferred),
      { url: preferred, method: "sendTransaction" },
    ]);
  });

  for (const { refusal, slug, refusingEndpoint } of [
    {
      refusal: "a served JSON-RPC error",
      slug: "json-rpc",
      refusingEndpoint: devnetJsonRpcError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR),
    },
    { refusal: "HTTP 429", slug: "http-429", refusingEndpoint: devnetHttpStatus(429) },
  ]) {
    it(`fails an airdrop refused with ${refusal} over to the next faucet without cooling the endpoint down`, async () => {
      mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      const refusing = `https://devnet-faucet-refusing-${slug}.example.test`;
      const funding = `https://devnet-faucet-funding-${slug}.example.test`;
      configurePool({
        SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: refusing,
        SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: funding,
      });
      const refusedCalls = stubEndpoints({
        [refusing]: refusingEndpoint,
        [funding]: SERVES_DEVNET,
      });
      // SAFETY: a sandbox scope resolves the devnet pool, whose nodes serve requestAirdrop; kit types
      // the pooled client as every cluster's union, mainnet's without the method.
      const rpc = runInClusterScope(SANDBOX, createClusterRpc) as Rpc<
        RequestAirdropApi & GetSlotApi
      >;

      assert.equal(
        await rpc.requestAirdrop(AIRDROP_RECIPIENT, lamports(1_000_000_000n)).send(),
        BigInt(SLOT)
      );
      assert.deepEqual(refusedCalls, [
        genesisProbe(refusing),
        airdropRequest(refusing),
        genesisProbe(funding),
        airdropRequest(funding),
      ]);

      const nextCalls = stubEndpoints({ [refusing]: SERVES_DEVNET, [funding]: SERVES_DEVNET });
      mock.timers.tick(1);
      assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
      assert.deepEqual(nextCalls, [slotRead(refusing)]);
    });
  }

  it("cools an endpoint down when it answers a read as unhealthy", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const preferred = "https://devnet-unhealthy-read-preferred.example.test";
    const fallback = "https://devnet-unhealthy-read-fallback.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: preferred,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: fallback,
    });
    const unhealthyCalls = stubEndpoints({
      [preferred]: devnetJsonRpcError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY),
      [fallback]: SERVES_DEVNET,
    });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(unhealthyCalls, [
      genesisProbe(preferred),
      slotRead(preferred),
      genesisProbe(fallback),
      slotRead(fallback),
    ]);

    const recoveredCalls = stubEndpoints({ [preferred]: SERVES_DEVNET, [fallback]: SERVES_DEVNET });
    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(recoveredCalls, [slotRead(fallback)]);
  });

  it("returns an unhealthy sendTransaction answer without failing over and cools the endpoint down", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const preferred = "https://devnet-unhealthy-send-preferred.example.test";
    const fallback = "https://devnet-unhealthy-send-fallback.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: preferred,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: fallback,
    });
    const unhealthyCalls = stubEndpoints({
      [preferred]: devnetJsonRpcError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY),
      [fallback]: SERVES_DEVNET,
    });
    const rpc = runInClusterScope(SANDBOX, createClusterRpc);

    await assert.rejects(
      rpc.sendTransaction(WIRE_TRANSACTION, { encoding: "base64" }).send(),
      (error) => isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)
    );
    assert.deepEqual(unhealthyCalls, [
      genesisProbe(preferred),
      { url: preferred, method: "sendTransaction" },
    ]);

    const recoveredCalls = stubEndpoints({ [preferred]: SERVES_DEVNET, [fallback]: SERVES_DEVNET });
    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(recoveredCalls, [genesisProbe(fallback), slotRead(fallback)]);
  });

  it("keeps the last endpoint cooling down when it answers a read as unhealthy", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const preferred = "https://devnet-last-unhealthy-preferred.example.test";
    const fallback = "https://devnet-last-unhealthy-fallback.example.test";
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

    const unhealthyCalls = stubEndpoints({
      [preferred]: devnetJsonRpcError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY),
      [fallback]: devnetJsonRpcError(
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED
      ),
    });
    mock.timers.tick(29_999);
    await assert.rejects(rpc.getSlot().send(), (error) =>
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)
    );
    assert.deepEqual(unhealthyCalls, [slotRead(fallback), slotRead(preferred)]);

    const recoveredCalls = stubEndpoints({ [preferred]: SERVES_DEVNET, [fallback]: SERVES_DEVNET });
    mock.timers.tick(1);
    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(recoveredCalls, [genesisProbe(fallback), slotRead(fallback)]);
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
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));
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
    assert.deepEqual(
      events.map((event) => [event.event, event.outcome, event.sample_weight]),
      [["sdp_rpc_attempt", "aborted", 1]]
    );
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
        .sendTransaction(WIRE_TRANSACTION, { encoding: "base64" })
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
      .sendTransaction(WIRE_TRANSACTION, { encoding: "base64" })
      .send();

    assert.deepEqual(calls, [
      genesisProbe(unproven),
      genesisProbe(proven),
      { url: proven, method: "sendTransaction" },
    ]);
  });
});

describe("createClusterRpc with a deadline", () => {
  beforeEach(isolateRpcEnv);

  afterEach(restoreRpcEnv);

  it("is memoized per deadline and pool, apart from the plain client", () => {
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet-bounded-memo.example.test",
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "https://mainnet-bounded-memo.example.test",
    });

    runInClusterScope(SANDBOX, () => {
      assert.equal(createClusterRpc({ timeoutMs: 2_000 }), createClusterRpc({ timeoutMs: 2_000 }));
      assert.notEqual(createClusterRpc({ timeoutMs: 2_000 }), createClusterRpc());
      assert.notEqual(
        createClusterRpc({ timeoutMs: 2_000 }),
        createClusterRpc({ timeoutMs: 3_000 })
      );
    });
    assert.notEqual(
      runInClusterScope(SANDBOX, () => createClusterRpc({ timeoutMs: 2_000 })),
      runInClusterScope(PRODUCTION, () => createClusterRpc({ timeoutMs: 2_000 }))
    );
  });

  it("shares the pool's cooldowns with the plain client", async () => {
    const down = "https://devnet-bounded-down.example.test";
    const healthy = "https://devnet-bounded-healthy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: down,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const calls = stubEndpoints({ [down]: DEVNET_FETCH_FAILS, [healthy]: SERVES_DEVNET });

    await runInClusterScope(SANDBOX, async () => {
      assert.equal(await createClusterRpc().getSlot().send(), BigInt(SLOT));
      assert.equal(await createClusterRpc({ timeoutMs: 2_000 }).getSlot().send(), BigInt(SLOT));
    });

    assert.deepEqual(calls, [
      genesisProbe(down),
      slotRead(down),
      genesisProbe(healthy),
      slotRead(healthy),
      slotRead(healthy),
    ]);
  });

  it("bounds each request end to end, failover included", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = "https://devnet-bounded-stalled.example.test";
    const healthy = "https://devnet-bounded-unreached.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: stalled,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
    });
    const stall = stubStalledDevnetRead(stalled);
    const events: RpcTelemetryEvent[] = [];
    setRpcTelemetrySink((event) => events.push(event));

    const slot = runInClusterScope(SANDBOX, () =>
      createClusterRpc({ timeoutMs: 2_000 }).getSlot().send()
    );
    await stall.readStalled;
    mock.timers.tick(2_000);

    await assert.rejects(slot, { name: "RpcTimeoutError" });
    assert.deepEqual(stall.calls, [genesisProbe(stalled), slotRead(stalled)]);
    assert.deepEqual(
      events.map((event) => event.outcome),
      ["aborted"]
    );
  });
});

describe("Earn's URL helpers", () => {
  const processDefault = { SOLANA_NETWORK: undefined, SOLANA_RPC_URL: undefined } as Record<
    string,
    string | undefined
  >;

  beforeEach(() => {
    isolateRpcEnv();
    processDefault.SOLANA_NETWORK = process.env.SOLANA_NETWORK;
    processDefault.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
  });

  afterEach(() => {
    restoreRpcEnv();
    for (const [envKey, value] of Object.entries(processDefault)) {
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it("list the scope's own pool on a devnet-default process, or none", () => {
    const processUrl = "https://devnet-earn-process-default.example.test";
    const mainnet = "https://mainnet-earn-pool.example.test";
    process.env.SOLANA_NETWORK = "devnet";
    process.env.SOLANA_RPC_URL = processUrl;
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: processUrl });

    assert.deepEqual(
      runInClusterScope(PRODUCTION, () => earnClusterEndpointUrls("mainnet-beta")),
      []
    );

    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: processUrl,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: mainnet,
    });
    assert.deepEqual(
      runInClusterScope(PRODUCTION, () => earnClusterEndpointUrls("mainnet-beta")),
      [mainnet]
    );
  });

  it("refuse a provider asking for the other cluster, and work outside a scope", async () => {
    const devnet = "https://devnet-earn-scope.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnet,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "https://mainnet-earn-scope.example.test",
    });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET });

    assert.throws(() => runInClusterScope(SANDBOX, () => earnClusterEndpointUrls("mainnet-beta")), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_CONFLICT",
      details: { openCluster: "devnet", requestedCluster: "mainnet-beta" },
    });
    await assert.rejects(
      runInClusterScope(PRODUCTION, () => proveEarnClusterEndpoint("devnet", devnet)),
      { name: "SdpRpcError", code: "CLUSTER_SCOPE_CONFLICT" }
    );
    assert.throws(() => earnClusterEndpointUrls("devnet"), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
    await assert.rejects(proveEarnClusterEndpoint("devnet", devnet), {
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
    assert.deepEqual(calls, []);
  });

  it("prove a pool endpoint with the pool's own genesis proof, both ways", async () => {
    const provedFirst = "https://devnet-earn-proved-first.example.test";
    const readFirst = "https://devnet-earn-read-first.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: provedFirst });
    const calls = stubEndpoints({ [provedFirst]: SERVES_DEVNET, [readFirst]: SERVES_DEVNET });

    await runInClusterScope(SANDBOX, async () => {
      await proveEarnClusterEndpoint("devnet", provedFirst);
      assert.equal(await createClusterRpc().getSlot().send(), BigInt(SLOT));
    });
    assert.deepEqual(calls, [genesisProbe(provedFirst), slotRead(provedFirst)]);

    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: readFirst });
    calls.length = 0;
    await runInClusterScope(SANDBOX, async () => {
      assert.equal(await createClusterRpc().getSlot().send(), BigInt(SLOT));
      await proveEarnClusterEndpoint("devnet", readFirst);
    });
    assert.deepEqual(calls, [genesisProbe(readFirst), slotRead(readFirst)]);
  });

  it("refuse to prove a URL outside the scope's pool, or one serving another cluster", async () => {
    const pooled = "https://devnet-earn-mismatch.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: pooled });
    const calls = stubEndpoints({ [pooled]: SERVES_MAINNET });

    await runInClusterScope(SANDBOX, async () => {
      await assert.rejects(
        proveEarnClusterEndpoint("devnet", "https://devnet-earn-stranger.example.test"),
        { name: "SdpRpcError", code: "RPC_NOT_CONFIGURED" }
      );
      assert.deepEqual(calls, []);
      await assert.rejects(proveEarnClusterEndpoint("devnet", pooled), {
        name: "SdpRpcError",
        code: "RPC_CLUSTER_MISMATCH",
      });
    });
    assert.deepEqual(calls, [genesisProbe(pooled)]);
  });
});

describe("createClusterHistoryRpc", () => {
  beforeEach(isolateRpcEnv);

  afterEach(restoreRpcEnv);

  it("tries the scope's own cluster Helius endpoint first, on a client apart from the plain pool", async () => {
    const devnetTriton = "https://devnet-history-triton.example.test";
    const devnetHelius = "https://devnet-history-helius.example.test";
    const devnetAlchemy = "https://devnet-history-alchemy.example.test";
    const mainnetTriton = "https://mainnet-history-triton.example.test";
    const mainnetHelius = "https://mainnet-history-helius.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnetTriton,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: devnetHelius,
      SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: devnetAlchemy,
      SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: mainnetTriton,
      SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: mainnetHelius,
    });
    const calls = stubEndpoints({
      [devnetTriton]: SERVES_DEVNET,
      [devnetHelius]: SERVES_DEVNET,
      [devnetAlchemy]: SERVES_DEVNET,
      [mainnetTriton]: SERVES_MAINNET,
      [mainnetHelius]: SERVES_MAINNET,
    });
    const sandboxHistoryRpc = runInClusterScope(SANDBOX, createClusterHistoryRpc);
    const sandboxRpc = runInClusterScope(SANDBOX, createClusterRpc);

    assert.notEqual(sandboxHistoryRpc, sandboxRpc);
    assert.equal(
      runInClusterScope(
        { projectId: "proj_factory_other", environment: "sandbox" },
        createClusterHistoryRpc
      ),
      sandboxHistoryRpc
    );

    assert.equal(await sandboxHistoryRpc.getSlot().send(), BigInt(SLOT));
    assert.equal(await sandboxRpc.getSlot().send(), BigInt(SLOT));
    assert.equal(
      await runInClusterScope(PRODUCTION, createClusterHistoryRpc).getSlot().send(),
      BigInt(SLOT)
    );
    assert.deepEqual(calls, [
      genesisProbe(devnetHelius),
      slotRead(devnetHelius),
      genesisProbe(devnetTriton),
      slotRead(devnetTriton),
      genesisProbe(mainnetHelius),
      slotRead(mainnetHelius),
    ]);
  });

  it("is the plain pool when the scope's cluster has no Helius endpoint, whatever another cluster has", async () => {
    const devnetTriton = "https://devnet-no-helius-triton.example.test";
    const devnetAlchemy = "https://devnet-no-helius-alchemy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: devnetTriton,
      SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: devnetAlchemy,
      SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: "https://mainnet-only-helius.example.test",
    });
    const calls = stubEndpoints({
      [devnetTriton]: SERVES_DEVNET,
      [devnetAlchemy]: SERVES_DEVNET,
    });
    const historyRpc = runInClusterScope(SANDBOX, createClusterHistoryRpc);

    assert.equal(historyRpc, runInClusterScope(SANDBOX, createClusterRpc));
    assert.equal(await historyRpc.getSlot().send(), BigInt(SLOT));
    assert.deepEqual(calls, [genesisProbe(devnetTriton), slotRead(devnetTriton)]);
  });

  it("fails over from Helius to the rest of the pool without retrying Helius under another provider's key", async () => {
    const helius = "https://devnet-history-down-helius.example.test";
    const alchemy = "https://devnet-history-up-alchemy.example.test";
    configurePool({
      SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: helius,
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: helius,
      SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: alchemy,
    });
    const calls = stubEndpoints({ [helius]: DEVNET_FETCH_FAILS, [alchemy]: SERVES_DEVNET });

    assert.equal(
      await runInClusterScope(SANDBOX, createClusterHistoryRpc).getSlot().send(),
      BigInt(SLOT)
    );
    assert.deepEqual(calls, [
      genesisProbe(helius),
      slotRead(helius),
      genesisProbe(alchemy),
      slotRead(alchemy),
    ]);
  });
});

describe("createKoraUpstreamRpc", () => {
  beforeEach(isolateRpcEnv);

  afterEach(restoreRpcEnv);

  it("sends a sandbox scope only to the devnet Kora upstream and a production scope only to mainnet's", async () => {
    const devnet = "https://kora-devnet-upstream.example.test";
    const mainnet = "https://kora-mainnet-upstream.example.test";
    configureKoraUpstreams({ KORA_DEVNET_RPC_URL: devnet, KORA_MAINNET_RPC_URL: mainnet });
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET, [mainnet]: SERVES_MAINNET });

    assert.equal(
      await runInClusterScope(SANDBOX, createKoraUpstreamRpc).getSlot().send(),
      BigInt(SLOT)
    );
    assert.equal(
      await runInClusterScope(PRODUCTION, createKoraUpstreamRpc).getSlot().send(),
      BigInt(SLOT)
    );
    assert.deepEqual(calls, [
      genesisProbe(devnet),
      slotRead(devnet),
      genesisProbe(mainnet),
      slotRead(mainnet),
    ]);
  });

  it("refuses a scope whose cluster's Kora upstream URL is blank or unset", () => {
    configureKoraUpstreams({ KORA_DEVNET_RPC_URL: "  " });

    assert.throws(() => runInClusterScope(SANDBOX, createKoraUpstreamRpc), {
      name: "SdpRpcError",
      message: "No Kora upstream RPC is configured for devnet: set KORA_DEVNET_RPC_URL",
      code: "RPC_NOT_CONFIGURED",
      statusCode: 503,
      details: { cluster: "devnet" },
    });
    assert.throws(() => runInClusterScope(PRODUCTION, createKoraUpstreamRpc), {
      name: "SdpRpcError",
      message: "No Kora upstream RPC is configured for mainnet-beta: set KORA_MAINNET_RPC_URL",
      code: "RPC_NOT_CONFIGURED",
      statusCode: 503,
      details: { cluster: "mainnet-beta" },
    });
  });

  it("refuses to build a client outside a cluster scope", () => {
    configureKoraUpstreams({ KORA_DEVNET_RPC_URL: "https://kora-unscoped.example.test" });

    assert.throws(() => createKoraUpstreamRpc(), {
      name: "SdpRpcError",
      message: "No cluster scope is open for this work",
      code: "CLUSTER_SCOPE_MISSING",
      statusCode: 500,
    });
  });

  it("shares one client per cluster and URL, apart from a pool client on the same URL", () => {
    const url = "https://kora-shared-with-pool.example.test";
    configurePool({ SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: url });
    configureKoraUpstreams({ KORA_DEVNET_RPC_URL: url });
    const koraRpc = runInClusterScope(SANDBOX, createKoraUpstreamRpc);

    assert.equal(
      runInClusterScope(
        { projectId: "proj_factory_other", environment: "sandbox" },
        createKoraUpstreamRpc
      ),
      koraRpc
    );
    assert.notEqual(runInClusterScope(SANDBOX, createClusterRpc), koraRpc);
  });
});
