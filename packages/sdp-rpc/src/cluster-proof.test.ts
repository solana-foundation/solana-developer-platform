import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import {
  assertClusterRpcUrl,
  CLUSTER_ENDPOINT_PROOF_TTL_MS,
  createRpc,
  resetClusterEndpointProofs,
} from "./solana";
import { withTransientRpcRetry } from "./transient";
import type { RpcEnv } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetClusterEndpointProofs();
});

function installRpcFetch(genesis: () => Promise<string> | string): { methods: string[] } {
  const state = { methods: [] as string[] };
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { id: string; method: string };
    state.methods.push(payload.method);
    const result = payload.method === "getGenesisHash" ? await genesis() : 123;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  return state;
}

test("mainnet proves an explicit URL before its first request and caches the verdict", async () => {
  const state = installRpcFetch(() => GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
  const rpc = createRpc({ SOLANA_NETWORK: "mainnet-beta" } as RpcEnv, {
    rpcUrl: "https://mainnet.example.invalid",
  });

  await rpc.getSlot().send();
  await rpc.getSlot().send();

  assert.deepEqual(state.methods, ["getGenesisHash", "getSlot", "getSlot"]);
});

test("mainnet rejects a mismatched genesis with observed, expected, and remediation", async () => {
  const state = installRpcFetch(() => GENESIS_HASH_BY_CLUSTER.devnet);
  const rpc = createRpc({
    SOLANA_NETWORK: "mainnet-beta",
    SOLANA_RPC_TRITON_URL: "https://wrong.example.invalid",
    SOLANA_RPC_HELIUS_URL: "https://unused.example.invalid",
  } as RpcEnv);

  await assert.rejects(
    () => withTransientRpcRetry(() => rpc.getSlot().send(), [0, 0]),
    new RegExp(
      `${GENESIS_HASH_BY_CLUSTER.devnet}.*${GENESIS_HASH_BY_CLUSTER["mainnet-beta"]}.*SOLANA_MAINNET_RPC_URL`
    )
  );
  assert.deepEqual(state.methods, ["getGenesisHash"]);
});

test("a rejected probe is evicted and concurrent requests coalesce", async () => {
  let calls = 0;
  let release: ((hash: string) => void) | undefined;
  const state = installRpcFetch(() => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const rpc = createRpc({ SOLANA_NETWORK: "mainnet-beta" } as RpcEnv, {
    rpcUrl: "https://recovering.example.invalid",
  });

  await assert.rejects(() => rpc.getSlot().send(), /Could not verify/);
  const first = rpc.getSlot().send();
  const second = rpc.getSlot().send();
  assert.equal(state.methods.filter((method) => method === "getGenesisHash").length, 2);
  assert.ok(release);
  release(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
  await Promise.all([first, second]);
});

test("mainnet re-proves after the short TTL", async () => {
  const state = installRpcFetch(() => GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const rpc = createRpc({ SOLANA_NETWORK: "mainnet-beta" } as RpcEnv, {
      rpcUrl: "https://ttl.example.invalid",
    });
    await rpc.getSlot().send();
    now += CLUSTER_ENDPOINT_PROOF_TTL_MS;
    await rpc.getSlot().send();
    assert.equal(state.methods.filter((method) => method === "getGenesisHash").length, 2);
  } finally {
    Date.now = realNow;
  }
});

test("devnet skips genesis proof", async () => {
  const state = installRpcFetch(() => GENESIS_HASH_BY_CLUSTER.devnet);
  const rpc = createRpc({ SOLANA_NETWORK: "devnet" } as RpcEnv, {
    rpcUrl: "https://localnet.example.invalid",
  });

  await rpc.getSlot().send();

  assert.deepEqual(state.methods, ["getSlot"]);
});

test("assertClusterRpcUrl proves a bare mainnet URL and skips devnet", async () => {
  const state = installRpcFetch(() => GENESIS_HASH_BY_CLUSTER.devnet);

  await assertClusterRpcUrl(
    { SOLANA_NETWORK: "devnet" } as RpcEnv,
    "https://devnet.example.invalid"
  );
  assert.deepEqual(state.methods, []);

  await assert.rejects(
    assertClusterRpcUrl(
      { SOLANA_NETWORK: "mainnet-beta" } as RpcEnv,
      "https://wrong.example.invalid"
    ),
    /reports genesis/
  );
  assert.deepEqual(state.methods, ["getGenesisHash"]);
});
