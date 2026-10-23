import type { SdpEnvironment } from "@sdp/types/api-keys";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";

const ledger = vi.hoisted(() => ({
  cleanupExpiredReservations: vi.fn(),
  hasUnconsumedExternalBuilds: vi.fn(),
  cleanupExpiredExternalBuilds: vi.fn(),
  claimUnsettledActions: vi.fn(),
  claimOpenRequests: vi.fn(),
  recordIndexError: vi.fn(),
}));

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories/earn-vault-withdrawal-requests.repository", () => ({
  createPostgresEarnVaultWithdrawalRequestsRepository: () => ledger,
}));

const { reconcileEarnVaultQueuedWithdrawals } = await import(
  "./vault-queued-withdrawal-reconciliation.service"
);

/** The block height each cluster's endpoint reports, so a cleanup shows whose height it got. */
const HEIGHTS = { devnet: 111, mainnet: 222 } as const;

let poolSequence = 0;
/** Every request of the current test, by endpoint and method, in arrival order. */
const requests: { url: string; method: string }[] = [];

function poolUrl(cluster: "devnet" | "mainnet"): string {
  return `https://${cluster}-${poolSequence}.queued-cleanup.test`;
}

function withBuildsIn(...environments: SdpEnvironment[]): void {
  ledger.hasUnconsumedExternalBuilds.mockImplementation(
    async ({ environment }: { environment: SdpEnvironment }) => environments.includes(environment)
  );
}

beforeEach(() => {
  poolSequence += 1;
  requests.length = 0;
  for (const fn of Object.values(ledger)) fn.mockReset();
  ledger.cleanupExpiredReservations.mockResolvedValue(0);
  ledger.cleanupExpiredExternalBuilds.mockResolvedValue(0);
  ledger.claimUnsettledActions.mockResolvedValue([]);
  ledger.claimOpenRequests.mockResolvedValue([]);
  vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", poolUrl("devnet"));
  vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", poolUrl("mainnet"));
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
    const url = String(input);
    requests.push({ url, method });
    const cluster = url === poolUrl("mainnet") ? "mainnet" : "devnet";
    const result =
      method === "getGenesisHash"
        ? GENESIS_HASH_BY_CLUSTER[cluster === "mainnet" ? "mainnet-beta" : "devnet"]
        : HEIGHTS[cluster];
    return Response.json({ jsonrpc: "2.0", id, result });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function blockHeightReads(): string[] {
  return requests.filter(({ method }) => method === "getBlockHeight").map(({ url }) => url);
}

describe("queued withdrawal build cleanup", () => {
  it("asks no cluster anything while no environment holds an unconsumed build", async () => {
    withBuildsIn();

    await reconcileEarnVaultQueuedWithdrawals(env);

    expect(requests).toEqual([]);
    expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
  });

  it("reads one height, from that environment's own cluster, per environment with builds", async () => {
    withBuildsIn("production");

    await reconcileEarnVaultQueuedWithdrawals(env);

    expect(blockHeightReads()).toEqual([poolUrl("mainnet")]);
    expect(ledger.cleanupExpiredExternalBuilds.mock.calls).toEqual([
      [{ environment: "production", currentBlockHeight: String(HEIGHTS.mainnet) }],
    ]);

    requests.length = 0;
    ledger.cleanupExpiredExternalBuilds.mockClear();
    withBuildsIn("sandbox", "production");

    await reconcileEarnVaultQueuedWithdrawals(env);

    expect(blockHeightReads()).toEqual([poolUrl("devnet"), poolUrl("mainnet")]);
    expect(ledger.cleanupExpiredExternalBuilds.mock.calls).toEqual([
      [{ environment: "sandbox", currentBlockHeight: String(HEIGHTS.devnet) }],
      [{ environment: "production", currentBlockHeight: String(HEIGHTS.mainnet) }],
    ]);
  });

  it("defers production cleanup rather than judge it by a devnet height", async () => {
    // How stage and prod are configured: a devnet process default and no mainnet override.
    vi.stubEnv("SOLANA_NETWORK", "devnet");
    vi.stubEnv("SOLANA_RPC_URL", poolUrl("devnet"));
    vi.stubEnv("SOLANA_MAINNET_RPC_URL", "");
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");
    withBuildsIn("production");

    await reconcileEarnVaultQueuedWithdrawals(env);

    expect(requests).toEqual([]);
    expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
  });
});
