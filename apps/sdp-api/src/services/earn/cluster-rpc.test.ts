import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import {
  assertClusterEndpoint,
  earnClusterRpc,
  earnPoolNotConfigured,
  earnProviderEndpointUrls,
} from "./cluster-rpc";

let poolSequence = 0;
/** Every request of the current test, by endpoint and method, in arrival order. */
const requests: { url: string; method: string }[] = [];
const genesisFor = vi.fn<(url: string) => string | Promise<string>>();

/** Fresh endpoints per test: the pool's clients and genesis proofs outlive a test. */
function endpoint(name: string): string {
  return `https://${name}-${poolSequence}.earn-cluster-rpc.test`;
}

/**
 * A process configured the way stage and prod are: `SOLANA_NETWORK=devnet` and a process
 * default that serves devnet, with no `SOLANA_MAINNET_RPC_URL`.
 */
function stubDevnetDefaultProcess(): void {
  vi.stubEnv("SOLANA_NETWORK", "devnet");
  vi.stubEnv("SOLANA_RPC_URL", endpoint("process-default"));
  vi.stubEnv("SOLANA_MAINNET_RPC_URL", "");
}

beforeEach(() => {
  poolSequence += 1;
  requests.length = 0;
  genesisFor
    .mockReset()
    .mockImplementation((url) =>
      url.includes("mainnet")
        ? GENESIS_HASH_BY_CLUSTER["mainnet-beta"]
        : GENESIS_HASH_BY_CLUSTER.devnet
    );
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method } = parseJsonRpcRequest(init);
    const url = String(input);
    requests.push({ url, method });
    const result = method === "getGenesisHash" ? await genesisFor(url) : 42;
    return Response.json({ jsonrpc: "2.0", id, result });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("earnClusterRpc on a devnet-default process", () => {
  it("reads mainnet from the mainnet pool, never the process default", async () => {
    stubDevnetDefaultProcess();
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    vi.stubEnv("SOLANA_RPC_TRITON_MAINNET_API_KEY_URL", endpoint("mainnet-pool"));

    await expect(earnClusterRpc("mainnet-beta").getSlot().send()).resolves.toBe(42n);
    await expect(earnClusterRpc("devnet").getSlot().send()).resolves.toBe(42n);

    expect(requests).toEqual([
      { url: endpoint("mainnet-pool"), method: "getGenesisHash" },
      { url: endpoint("mainnet-pool"), method: "getSlot" },
      { url: endpoint("devnet-pool"), method: "getGenesisHash" },
      { url: endpoint("devnet-pool"), method: "getSlot" },
    ]);
  });

  it("refuses a cluster with no pool instead of reading the other one", () => {
    stubDevnetDefaultProcess();
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    expect(() => earnClusterRpc("mainnet-beta")).toThrow(
      expect.objectContaining({ code: "RPC_NOT_CONFIGURED", details: { cluster: "mainnet-beta" } })
    );
    expect(earnProviderEndpointUrls("mainnet-beta")).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("lists only the requested cluster's endpoints, in pool order", () => {
    stubDevnetDefaultProcess();
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", endpoint("devnet-helius"));
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", endpoint("devnet-triton"));
    vi.stubEnv("SOLANA_RPC_TRITON_MAINNET_API_KEY_URL", endpoint("mainnet-triton"));

    expect(earnProviderEndpointUrls("devnet")).toEqual([
      endpoint("devnet-triton"),
      endpoint("devnet-helius"),
    ]);
    expect(earnProviderEndpointUrls("mainnet-beta")).toEqual([endpoint("mainnet-triton")]);
  });

  it("is the scope's own client in that cluster's scope, and refuses the other cluster there", () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", endpoint("mainnet-pool"));
    const production = { projectId: "prj_earn_cluster_rpc", environment: "production" } as const;

    expect(runInClusterScope(production, () => earnClusterRpc("mainnet-beta"))).toBe(
      runInClusterScope(production, createClusterRpc)
    );
    expect(() => runInClusterScope(production, () => earnClusterRpc("devnet"))).toThrow(
      expect.objectContaining({ code: "CLUSTER_SCOPE_CONFLICT" })
    );
    expect(() => runInClusterScope(production, () => earnProviderEndpointUrls("devnet"))).toThrow(
      expect.objectContaining({ code: "CLUSTER_SCOPE_CONFLICT" })
    );
  });

  it("bounds a request end to end when asked", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    genesisFor.mockReturnValue(new Promise<string>(() => undefined));

    const read = earnClusterRpc("devnet", { timeoutMs: 50 }).getSlot().send();
    const rejection = expect(read).rejects.toThrow("RPC request timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});

describe("assertClusterEndpoint", () => {
  const cluster: SolanaCluster = "devnet";

  it("names the managed pool keys when the cluster has no endpoint", () => {
    expect(earnProviderEndpointUrls(cluster)).toEqual([]);
    expect(earnPoolNotConfigured(cluster)).toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: expect.stringContaining("SOLANA_RPC_<PROVIDER>_DEVNET_API_KEY_URL"),
    });
    expect(requests).toEqual([]);
  });

  it("refuses a URL outside the cluster's pool without probing it", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await expect(assertClusterEndpoint(cluster, endpoint("stranger"))).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: expect.stringContaining("not in the devnet managed pool"),
    });
    expect(requests).toEqual([]);
  });

  it("refuses an endpoint that serves another cluster, re-probing every time", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    genesisFor.mockReturnValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(assertClusterEndpoint(cluster, endpoint("devnet-pool"))).rejects.toMatchObject({
        code: "PROVIDER_NOT_CONFIGURED",
        message: expect.stringContaining(
          `reports genesis ${GENESIS_HASH_BY_CLUSTER["mainnet-beta"]}, not ${GENESIS_HASH_BY_CLUSTER.devnet}`
        ),
      });
    }
    expect(requests).toHaveLength(2);
  });

  it("evicts a failed probe so the endpoint can recover, then trusts the proof", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    genesisFor.mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed")));

    await expect(assertClusterEndpoint(cluster, endpoint("devnet-pool"))).rejects.toThrow(
      /Could not verify/
    );
    await expect(assertClusterEndpoint(cluster, endpoint("devnet-pool"))).resolves.toBeUndefined();
    await expect(assertClusterEndpoint(cluster, endpoint("devnet-pool"))).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("coalesces concurrent probes", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await expect(
      Promise.all([
        assertClusterEndpoint(cluster, endpoint("devnet-pool")),
        assertClusterEndpoint(cluster, endpoint("devnet-pool")),
      ])
    ).resolves.toEqual([undefined, undefined]);
    expect(requests).toEqual([{ url: endpoint("devnet-pool"), method: "getGenesisHash" }]);
  });

  it("shares the pool's proof both ways, and re-proves once it is 30 s old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await earnClusterRpc(cluster).getSlot().send();
    await assertClusterEndpoint(cluster, endpoint("devnet-pool"));
    expect(requests.map(({ method }) => method)).toEqual(["getGenesisHash", "getSlot"]);

    vi.setSystemTime(new Date("2026-10-23T00:00:30.000Z"));
    await assertClusterEndpoint(cluster, endpoint("devnet-pool"));
    await earnClusterRpc(cluster).getSlot().send();
    expect(requests.map(({ method }) => method)).toEqual([
      "getGenesisHash",
      "getSlot",
      "getGenesisHash",
      "getSlot",
    ]);
  });
});
