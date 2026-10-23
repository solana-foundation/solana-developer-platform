import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import {
  assertClusterEndpoint,
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

const SANDBOX = { projectId: null, environment: "sandbox" } as const;
const PRODUCTION = { projectId: "prj_earn_cluster_rpc", environment: "production" } as const;

/** Provider work in the scope a sandbox request or cron opens. */
function inSandbox<T>(work: () => T): T {
  return runInClusterScope(SANDBOX, work);
}

describe("earnProviderEndpointUrls on a devnet-default process", () => {
  it("lists the scope's own pool, never the process default", () => {
    stubDevnetDefaultProcess();
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", endpoint("devnet-helius"));
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", endpoint("devnet-triton"));
    vi.stubEnv("SOLANA_RPC_TRITON_MAINNET_API_KEY_URL", endpoint("mainnet-triton"));

    expect(inSandbox(() => earnProviderEndpointUrls("devnet"))).toEqual([
      endpoint("devnet-triton"),
      endpoint("devnet-helius"),
    ]);
    expect(runInClusterScope(PRODUCTION, () => earnProviderEndpointUrls("mainnet-beta"))).toEqual([
      endpoint("mainnet-triton"),
    ]);
    expect(requests).toEqual([]);
  });

  it("lists none when the scope's cluster has no pool, instead of the other cluster's", () => {
    stubDevnetDefaultProcess();
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    expect(runInClusterScope(PRODUCTION, () => earnProviderEndpointUrls("mainnet-beta"))).toEqual(
      []
    );
    expect(requests).toEqual([]);
  });

  it("refuses a provider asking for the other cluster, and work outside a scope", () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", endpoint("mainnet-pool"));

    expect(() => runInClusterScope(PRODUCTION, () => earnProviderEndpointUrls("devnet"))).toThrow(
      expect.objectContaining({
        code: "CLUSTER_SCOPE_CONFLICT",
        details: { openCluster: "mainnet-beta", requestedCluster: "devnet" },
      })
    );
    expect(() => earnProviderEndpointUrls("devnet")).toThrow(
      expect.objectContaining({ code: "CLUSTER_SCOPE_MISSING" })
    );
  });
});

describe("assertClusterEndpoint", () => {
  const cluster: SolanaCluster = "devnet";

  it("names the managed pool keys when the cluster has no endpoint", () => {
    expect(inSandbox(() => earnProviderEndpointUrls(cluster))).toEqual([]);
    expect(earnPoolNotConfigured(cluster)).toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: expect.stringContaining("SOLANA_RPC_<PROVIDER>_DEVNET_API_KEY_URL"),
    });
    expect(requests).toEqual([]);
  });

  it("refuses a URL outside the cluster's pool without probing it", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await expect(
      inSandbox(() => assertClusterEndpoint(cluster, endpoint("stranger")))
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: expect.stringContaining("not in the devnet managed pool"),
    });
    expect(requests).toEqual([]);
  });

  it("refuses an endpoint that serves another cluster, re-probing every time", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));
    genesisFor.mockReturnValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")))
      ).rejects.toMatchObject({
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

    await expect(
      inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")))
    ).rejects.toThrow(/Could not verify/);
    await expect(
      inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")))
    ).resolves.toBeUndefined();
    await expect(
      inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")))
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("coalesces concurrent probes", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await expect(
      Promise.all([
        inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool"))),
        inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool"))),
      ])
    ).resolves.toEqual([undefined, undefined]);
    expect(requests).toEqual([{ url: endpoint("devnet-pool"), method: "getGenesisHash" }]);
  });

  it("shares the pool's proof both ways, and re-proves once it is 30 s old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", endpoint("devnet-pool"));

    await inSandbox(() => createClusterRpc().getSlot().send());
    await inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")));
    expect(requests.map(({ method }) => method)).toEqual(["getGenesisHash", "getSlot"]);

    vi.setSystemTime(new Date("2026-10-23T00:00:30.000Z"));
    await inSandbox(() => assertClusterEndpoint(cluster, endpoint("devnet-pool")));
    await inSandbox(() => createClusterRpc().getSlot().send());
    expect(requests.map(({ method }) => method)).toEqual([
      "getGenesisHash",
      "getSlot",
      "getGenesisHash",
      "getSlot",
    ]);
  });
});
