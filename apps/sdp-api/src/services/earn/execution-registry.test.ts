import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  assertClusterEndpoint,
  CLUSTER_ENDPOINT_PROOF_TTL_MS,
  resetClusterEndpointProofs,
} from "./execution-registry";

const env = {} as Env;
const rpcUrl = "https://rpc.example.invalid";

function mockGenesisSend() {
  const send = vi.fn();
  vi.spyOn(solanaRpc, "createRpc").mockReturnValue({
    getGenesisHash: () => ({ send }),
  } as never);
  return send;
}

beforeEach(() => {
  resetClusterEndpointProofs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("assertClusterEndpoint", () => {
  it("evicts a transient probe rejection so the endpoint can recover", async () => {
    const send = mockGenesisSend()
      .mockRejectedValueOnce(new Error("RPC request timed out after 30000ms"))
      .mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/Could not verify/);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    // The successful observation is cached only for the short trust window.
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("caches an observed mismatch only within the short trust window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const send = mockGenesisSend().mockResolvedValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(CLUSTER_ENDPOINT_PROOF_TTL_MS);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent probes and caches the successful observation", async () => {
    let resolveGenesis!: (hash: string) => void;
    const send = mockGenesisSend().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGenesis = resolve;
      })
    );

    const first = assertClusterEndpoint(env, "devnet", rpcUrl);
    const second = assertClusterEndpoint(env, "devnet", rpcUrl);
    expect(send).toHaveBeenCalledOnce();

    resolveGenesis(GENESIS_HASH_BY_CLUSTER.devnet);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
  });

  it("re-proves a successful URL after its trust window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const send = mockGenesisSend().mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    vi.advanceTimersByTime(CLUSTER_ENDPOINT_PROOF_TTL_MS - 1);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
