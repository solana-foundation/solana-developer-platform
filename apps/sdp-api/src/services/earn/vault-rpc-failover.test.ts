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

/** The shape Veda and Kamino position reads throw: failures sit in `.errors`. */
function fanOutFailure(...causes: Error[]): Error {
  return new Error(`Could not read ${causes.length} vault positions`, {
    cause: new AggregateError(
      causes.map((cause, index) => new Error(`Vault ${index} read failed`, { cause })),
      "Vault position reads failed"
    ),
  });
}

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

  it("retries a per-vault fan-out whose every failure is transient", async () => {
    const rpc = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    const visited: string[] = [];
    const result = await rpc.run("Read vault positions", async () => {
      const url = await rpc.resolve(runtime, "devnet");
      visited.push(url);
      if (url === primary)
        throw fanOutFailure(
          new TypeError("fetch failed", { cause: new Error("other side closed") }),
          new Error("HTTP error (429): Too Many Requests")
        );
      return "verified vault state";
    });
    expect(result).toBe("verified vault state");
    expect(visited).toEqual([primary, fallback]);
  });

  const cyclic = new Error("Vault unreadable");
  cyclic.cause = cyclic;
  it.each([
    [
      "a fan-out with one deterministic failure",
      fanOutFailure(new TypeError("fetch failed"), new Error("Vault account does not exist")),
    ],
    [
      "an empty fan-out",
      new Error("Vault unreadable", { cause: new AggregateError([], "No reads ran") }),
    ],
    ["a cyclic cause chain", cyclic],
  ])("does not retry %s", async (_label, failure) => {
    const rpc = createVaultRpcFailover(env, createVaultDeadline(), assertClusterEndpoint);
    const read = vi.fn(async () => {
      await rpc.resolve(runtime, "devnet");
      throw failure;
    });
    await expect(rpc.run("Read vault positions", read)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
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
