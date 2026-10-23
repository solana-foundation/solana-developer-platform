import type { SdpEnvironment } from "@sdp/types/api-keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { cleanupAbandonedExternalBuilds } from "./vault-queued-withdrawal-reconciliation.service";

/** The confirmed height each cluster's endpoint reports, so a cleanup shows whose height it got. */
const HEIGHTS = { devnet: 111, "mainnet-beta": 222 } as const;

describe("queued withdrawal build cleanup", () => {
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    rpc.respond("getBlockHeight", ({ cluster }) => ({ result: HEIGHTS[cluster] }));
  });

  function ledgerWithBuildsIn(...environments: SdpEnvironment[]) {
    return {
      hasUnconsumedExternalBuilds: vi.fn<
        EarnVaultWithdrawalRequestsRepository["hasUnconsumedExternalBuilds"]
      >(async ({ environment }) => environments.includes(environment)),
      cleanupExpiredExternalBuilds: vi.fn<
        EarnVaultWithdrawalRequestsRepository["cleanupExpiredExternalBuilds"]
      >(async () => 0),
    };
  }

  function blockHeightReads(): string[] {
    return rpc.calls
      .filter(({ method }) => method === "getBlockHeight")
      .map(({ cluster }) => cluster);
  }

  it("asks no cluster anything while no environment holds an unconsumed build", async () => {
    const ledger = ledgerWithBuildsIn();

    await cleanupAbandonedExternalBuilds(ledger);

    expect(rpc.calls).toEqual([]);
    expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
  });

  it("reads one height, from that environment's own cluster, per environment with builds", async () => {
    const production = ledgerWithBuildsIn("production");
    await cleanupAbandonedExternalBuilds(production);

    expect(blockHeightReads()).toEqual(["mainnet-beta"]);
    expect(production.cleanupExpiredExternalBuilds.mock.calls).toEqual([
      [{ environment: "production", currentBlockHeight: String(HEIGHTS["mainnet-beta"]) }],
    ]);

    const both = ledgerWithBuildsIn("sandbox", "production");
    await cleanupAbandonedExternalBuilds(both);

    expect(blockHeightReads()).toEqual(["mainnet-beta", "devnet", "mainnet-beta"]);
    expect(both.cleanupExpiredExternalBuilds.mock.calls).toEqual([
      [{ environment: "sandbox", currentBlockHeight: String(HEIGHTS.devnet) }],
      [{ environment: "production", currentBlockHeight: String(HEIGHTS["mainnet-beta"]) }],
    ]);
  });

  it("defers production cleanup rather than judge it by a devnet height", async () => {
    // How stage and prod are configured without a mainnet pool: a devnet process default.
    vi.stubEnv("SOLANA_NETWORK", "devnet");
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");
    const ledger = ledgerWithBuildsIn("production");

    await cleanupAbandonedExternalBuilds(ledger);

    expect(rpc.calls).toEqual([]);
    expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
  });
});
