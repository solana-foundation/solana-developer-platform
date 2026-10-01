import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { assertClusterEndpoint, resetClusterEndpointProofs } from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import { createVaultRpcFailover } from "./vault-rpc-failover";

const primary = "https://primary.example.invalid";
const fallback = "https://fallback.example.invalid";
const env = {
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_HELIUS_URL: primary,
  SOLANA_RPC_ALCHEMY_URL: fallback,
} as Env;
const runtime = { env: {}, environment: "sandbox" } as const;
const genesis = vi.fn<(url: string) => Promise<string>>();
beforeEach(() => {
  resetClusterEndpointProofs();
  genesis.mockReset().mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);
  vi.spyOn(solanaRpc, "createRpc").mockImplementation(
    (_env, options) =>
      ({
        getGenesisHash: () => ({ send: () => genesis(options?.rpcUrl ?? "missing-endpoint") }),
      }) as never
  );
});
afterEach(() => vi.restoreAllMocks());

describe("Earn RPC fallback", () => {
  it("retries a nested provider transport failure on a separately proven endpoint", async () => {
    const rpc = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    const visited: string[] = [];
    const result = await rpc.run("Read vault", async () => {
      const url = await rpc.resolve(runtime, "devnet");
      visited.push(url);
      if (url === primary)
        throw new Error("Vault unreadable", { cause: new Error("fetch failed") });
      return "verified vault state";
    });
    expect(result).toBe("verified vault state");
    expect(visited).toEqual([primary, fallback]);
    expect(genesis.mock.calls.map(([url]) => url)).toEqual([primary, fallback]);
  });

  it("never reads/builds on a fallback that reports the wrong cluster", async () => {
    genesis.mockImplementation(
      async (url) => GENESIS_HASH_BY_CLUSTER[url === primary ? "devnet" : "mainnet-beta"]
    );
    const rpc = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    const read = vi.fn(async () => {
      await rpc.resolve(runtime, "devnet");
      throw new Error("503 service unavailable");
    });
    await expect(rpc.run("Read vault", read)).rejects.toThrow(/reports genesis/);
    expect(read).toHaveBeenCalledTimes(2);
    expect(genesis).toHaveBeenCalledWith(fallback);
  });

  it("does not retain the fallback for later historical reads or reinterpret absent evidence", async () => {
    const rpc = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    await rpc.run("Build", async () => {
      if ((await rpc.resolve(runtime, "devnet")) === primary) throw new Error("fetch failed");
    });
    const visited: string[] = [];
    const evidence = await rpc.run("Read receipt", async () => {
      visited.push(await rpc.resolve(runtime, "devnet"));
      return null;
    });
    expect(evidence).toBeNull();
    expect(visited).toEqual([primary]);
  });

  it("does not retry a deterministic refusal or override an explicit cluster pin", async () => {
    const rpc = createVaultRpcFailover(
      { ...env, SOLANA_DEVNET_RPC_URL: primary },
      createVaultDeadline(),
      assertClusterEndpoint
    );
    const read = vi.fn(async () => {
      await rpc.resolve(runtime, "devnet");
      throw new Error("fetch failed");
    });
    await expect(rpc.run("Read vault", read)).rejects.toThrow("fetch failed");
    expect(read).toHaveBeenCalledTimes(1);
    const unpinned = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    const refused = vi.fn(async () => {
      await unpinned.resolve(runtime, "devnet");
      throw new Error("Insufficient funds");
    });
    await expect(unpinned.run("Build", refused)).rejects.toThrow("Insufficient funds");
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
