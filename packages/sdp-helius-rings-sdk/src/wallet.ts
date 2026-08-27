import { Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  SyncReport as SdkSyncReport,
  SyncWalletAuthority,
  WalletAuthority,
} from "@heliuslabs/zolana/transaction";
import { syncWallet } from "@heliuslabs/zolana/wallet";
import type { ShieldedMaterial } from "./material.js";

/**
 * An authority that can do nothing but hand over reading material. `syncWallet`
 * only ever calls `syncMaterial`, so the cast widens that narrower contract: an
 * SDK that tried to spend during a sync fails on a missing method instead.
 */
export function readOnlyAuthority(material: ShieldedMaterial): WalletAuthority {
  const authority: SyncWalletAuthority = {
    syncMaterial: async () => ({
      identity: material.shieldedAddress,
      viewingKeys: [material.viewingKey],
      nullifierKey: material.nullifierKey,
    }),
  };

  return authority as WalletAuthority;
}

export interface HydrateWalletInput {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterial;
  readonly authority: WalletAuthority;
}

export interface HydratedWallet {
  readonly wallet: Wallet;
  readonly report: SdkSyncReport;
}

export type SdkSyncAnomaly = Exclude<keyof SdkSyncReport, "storedUtxos">;
export type SyncAnomalyCounts = Record<SdkSyncAnomaly, number>;

/**
 * One exhaustive projection of every upstream anomaly: a new Zolana report field
 * fails typechecking here until its JSON-safe count is mapped.
 */
export function syncAnomalyCounts(report: SdkSyncReport): SyncAnomalyCounts {
  return {
    unparsedTransactions: report.unparsedTransactions,
    undecryptableCandidates: report.undecryptableCandidates,
    unknownAssetIds: report.unknownAssetIds.length,
    unknownAssetFields: report.unknownAssetFields.length,
  } satisfies SyncAnomalyCounts;
}

export function hasSyncAnomalies(anomalies: SyncAnomalyCounts): boolean {
  return Object.values(anomalies).some((count) => count > 0);
}

/**
 * Builds a wallet on the identity the material publishes and reads its state. An
 * incomplete read is not fatal because a partial balance is still worth
 * returning as long as the caller is told; a spend path could not be this tolerant.
 */
export async function hydrateWallet(input: HydrateWalletInput): Promise<HydratedWallet> {
  const wallet = new Wallet({ identity: input.material.shieldedAddress });
  const report = await syncWallet({
    wallet,
    authority: input.authority,
    client: input.client,
  });

  return { wallet, report };
}
