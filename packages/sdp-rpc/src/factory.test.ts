import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { createRpc } from "./factory";

type Endpoint = { kind: "serves"; genesisHash: string } | { kind: "unreachable" };

type RpcCall = { url: string; method: string };

const SERVES_DEVNET: Endpoint = { kind: "serves", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet };
const SERVES_MAINNET: Endpoint = {
  kind: "serves",
  genesisHash: GENESIS_HASH_BY_CLUSTER["mainnet-beta"],
};
const UNREACHABLE: Endpoint = { kind: "unreachable" };

const SLOT = 7;

const originalFetch = globalThis.fetch;

function readRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): { url: string; id: unknown; method: string } {
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
  return { url: input, id: payload.id, method: payload.method };
}

function stubEndpoints(endpoints: Readonly<Record<string, Endpoint>>): RpcCall[] {
  const calls: RpcCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = readRequest(input, init);
    calls.push({ url: request.url, method: request.method });
    const endpoint = endpoints[request.url];
    if (endpoint.kind === "unreachable") {
      throw new TypeError("fetch failed");
    }
    const result = request.method === "getGenesisHash" ? endpoint.genesisHash : SLOT;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  return calls;
}

function genesisProbe(url: string): RpcCall {
  return { url, method: "getGenesisHash" };
}

function slotRead(url: string): RpcCall {
  return { url, method: "getSlot" };
}

describe("createRpc", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  });

  it("proves genesis before the first request, trusts it for 30 seconds, then re-proves", async () => {
    const url = "https://rpc-ttl.test/devnet";
    const calls = stubEndpoints({ [url]: SERVES_DEVNET });
    const rpc = createRpc({ SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: url }, "devnet");

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

  it("rejects a cluster mismatch without failing over and without recording a proof", async () => {
    const wrongCluster = "https://rpc-mismatch-a.test/devnet";
    const healthy = "https://rpc-mismatch-b.test/devnet";
    const calls = stubEndpoints({ [wrongCluster]: SERVES_MAINNET, [healthy]: SERVES_DEVNET });
    const rpc = createRpc(
      {
        SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: wrongCluster,
        SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
      },
      "devnet"
    );
    const mismatch = {
      name: "SdpRpcError",
      message: "An RPC endpoint configured for devnet serves a different cluster",
      code: "RPC_CLUSTER_MISMATCH",
      statusCode: 500,
      details: { cluster: "devnet", genesisHash: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] },
    };

    await assert.rejects(rpc.getSlot().send(), mismatch);
    await assert.rejects(rpc.getSlot().send(), mismatch);

    assert.deepEqual(calls, [genesisProbe(wrongCluster), genesisProbe(wrongCluster)]);
  });

  it("fails over on a probe network error to the next provider, which proves genesis and serves", async () => {
    const unreachable = "https://rpc-probe-down-a.test/devnet";
    const healthy = "https://rpc-probe-down-b.test/devnet";
    const calls = stubEndpoints({ [unreachable]: UNREACHABLE, [healthy]: SERVES_DEVNET });
    const rpc = createRpc(
      {
        SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: unreachable,
        SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: healthy,
      },
      "devnet"
    );

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));

    assert.deepEqual(calls, [genesisProbe(unreachable), genesisProbe(healthy), slotRead(healthy)]);
  });

  it("tries providers in table order", async () => {
    const triton = "https://rpc-order-triton.test/devnet";
    const alchemy = "https://rpc-order-alchemy.test/devnet";
    const fallback = "https://rpc-order-default.test/devnet";
    const calls = stubEndpoints({
      [triton]: UNREACHABLE,
      [alchemy]: UNREACHABLE,
      [fallback]: SERVES_DEVNET,
    });
    const rpc = createRpc(
      {
        SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: fallback,
        SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: alchemy,
        SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: triton,
      },
      "devnet"
    );

    assert.equal(await rpc.getSlot().send(), BigInt(SLOT));

    assert.deepEqual(calls, [
      genesisProbe(triton),
      genesisProbe(alchemy),
      genesisProbe(fallback),
      slotRead(fallback),
    ]);
  });

  it("refuses a cluster with an empty pool while the configured cluster still serves", async () => {
    const devnet = "https://rpc-empty-pool.test/devnet";
    const calls = stubEndpoints({ [devnet]: SERVES_DEVNET });
    const env = { SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: devnet };

    assert.throws(() => createRpc(env, "mainnet-beta"), {
      name: "SdpRpcError",
      message: "No RPC endpoint is configured for mainnet-beta",
      code: "RPC_NOT_CONFIGURED",
      statusCode: 503,
      details: { cluster: "mainnet-beta" },
    });
    assert.equal(await createRpc(env, "devnet").getSlot().send(), BigInt(SLOT));

    assert.deepEqual(calls, [genesisProbe(devnet), slotRead(devnet)]);
  });

  it("proves the same URL separately for each cluster it is configured for", async () => {
    const url = "https://rpc-cluster-isolation.test/shared";
    const calls = stubEndpoints({ [url]: SERVES_DEVNET });
    const env = {
      SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: url,
      SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: url,
    };
    const devnetRpc = createRpc(env, "devnet");

    assert.equal(await devnetRpc.getSlot().send(), BigInt(SLOT));
    await assert.rejects(createRpc(env, "mainnet-beta").getSlot().send(), {
      name: "SdpRpcError",
      message: "An RPC endpoint configured for mainnet-beta serves a different cluster",
      code: "RPC_CLUSTER_MISMATCH",
      statusCode: 500,
      details: { cluster: "mainnet-beta", genesisHash: GENESIS_HASH_BY_CLUSTER.devnet },
    });
    assert.equal(await devnetRpc.getSlot().send(), BigInt(SLOT));

    assert.deepEqual(calls, [genesisProbe(url), slotRead(url), genesisProbe(url), slotRead(url)]);
  });
});
