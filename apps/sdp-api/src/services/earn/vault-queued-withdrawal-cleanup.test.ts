import type { SdpEnvironment } from "@sdp/types/api-keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { ENVIRONMENT_CLUSTER_CASES, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
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

  it.each(ENVIRONMENT_CLUSTER_CASES)(
    "asks $cluster nothing while $environment holds no unconsumed build",
    async ({ environment }) => {
      const ledger = ledgerWithBuildsIn(environment === "sandbox" ? "production" : "sandbox");

      await runInEnvironmentClusterScope(environment, () => cleanupAbandonedExternalBuilds(ledger));

      expect(rpc.calls).toEqual([]);
      expect(ledger.hasUnconsumedExternalBuilds.mock.calls).toEqual([[{ environment }]]);
      expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
    }
  );

  it.each(ENVIRONMENT_CLUSTER_CASES)(
    "expires only $environment builds, against $cluster's own height",
    async ({ environment, cluster }) => {
      const ledger = ledgerWithBuildsIn("sandbox", "production");

      await runInEnvironmentClusterScope(environment, () => cleanupAbandonedExternalBuilds(ledger));

      expect(blockHeightReads()).toEqual([cluster]);
      expect(ledger.cleanupExpiredExternalBuilds.mock.calls).toEqual([
        [{ environment, currentBlockHeight: String(HEIGHTS[cluster]) }],
      ]);
    }
  );

  it("defers production cleanup rather than judge it by a devnet height", async () => {
    // How stage and prod are configured without a mainnet pool: a devnet process default.
    vi.stubEnv("SOLANA_NETWORK", "devnet");
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");
    const ledger = ledgerWithBuildsIn("production");

    await runInEnvironmentClusterScope("production", () => cleanupAbandonedExternalBuilds(ledger));

    expect(rpc.calls).toEqual([]);
    expect(ledger.cleanupExpiredExternalBuilds).not.toHaveBeenCalled();
  });
});
