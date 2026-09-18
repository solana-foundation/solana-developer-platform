import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explicitClusterRpcUrl, resolveClusterRpcUrl, resolveDefaultCluster } from "./config";
import { createClusterRpc } from "./solana";
import type { RpcEnv } from "./types";

/**
 * One process may serve both clusters. These pin how a cluster's endpoint is
 * chosen: an explicit `SOLANA_<CLUSTER>_RPC_URL` wins for ANY cluster, the
 * default included; the default cluster otherwise falls back to the process
 * configuration; the other cluster has nothing to fall back to.
 */
describe("cluster RPC selection", () => {
  const devnetDefault: RpcEnv = {
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: "https://process-default.example",
  };

  it("names the process default cluster", () => {
    assert.equal(resolveDefaultCluster({}), "devnet");
    assert.equal(resolveDefaultCluster({ SOLANA_NETWORK: "mainnet-beta" }), "mainnet-beta");
  });

  it("honors an explicit override for the default cluster too", () => {
    const env: RpcEnv = {
      ...devnetDefault,
      SOLANA_DEVNET_RPC_URL: " https://private-devnet.example ",
    };
    assert.equal(explicitClusterRpcUrl(env, "devnet"), "https://private-devnet.example");
    assert.equal(resolveClusterRpcUrl(env, "devnet"), "https://private-devnet.example");
    assert.doesNotThrow(() => createClusterRpc(env, "devnet"));
  });

  it("falls back to the process configuration for the default cluster only", () => {
    assert.equal(resolveClusterRpcUrl(devnetDefault, "devnet"), "https://process-default.example");
    assert.equal(resolveClusterRpcUrl(devnetDefault, "mainnet-beta"), "");
    assert.equal(explicitClusterRpcUrl(devnetDefault, "mainnet-beta"), undefined);
  });

  it("refuses to build a client for a cluster with no endpoint", () => {
    assert.throws(
      () => createClusterRpc(devnetDefault, "mainnet-beta"),
      /No RPC endpoint is configured for mainnet-beta: set SOLANA_MAINNET_RPC_URL/
    );
    assert.doesNotThrow(() =>
      createClusterRpc(
        { ...devnetDefault, SOLANA_MAINNET_RPC_URL: "https://mainnet.example" },
        "mainnet-beta"
      )
    );
  });
});
