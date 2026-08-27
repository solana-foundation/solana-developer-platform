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
 * An authority that can do nothing but hand over reading material.
 *
 * `syncWallet` is typed against the full `WalletAuthority` but only ever calls
 * `syncMaterial`, and the SDK names that narrower contract itself. Building a
 * spending authority for a read would have meant inventing an approval for an
 * operation that does not exist, so the cast widens the narrow one instead: a
 * future SDK that really did try to spend during a sync fails loudly on a
 * missing method rather than signing something unapproved.
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
 * Keep every upstream anomaly in one exhaustive projection. A new Zolana
 * report field fails typechecking here until its JSON-safe count is mapped.
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
 * Builds a wallet on the identity the material publishes and reads its state.
 *
 * An incomplete read is not fatal, because reporting a balance is the only thing
 * this build does with one and a partial balance is still worth returning as long
 * as the caller is told it is partial. A spend path could not be this tolerant,
 * which is why note selection is out of scope rather than permissive.
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
