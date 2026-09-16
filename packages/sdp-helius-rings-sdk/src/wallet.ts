import { Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { SyncReport as SdkSyncReport, ShieldedKeys } from "@heliuslabs/zolana/transaction";
import { syncWallet } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { canonicalShieldedIdentity } from "./material.js";
import { getCachedWallet, setCachedWallet } from "./wallet-cache.js";

export interface HydrateWalletInput {
  /** Cache key: same across sync and spend paths for one Rings identity. */
  readonly walletId: string;
  readonly client: ZolanaClient;
  /**
   * A sync needs only `ShieldedKeys`, so the read path can pass `readKeys` and
   * have no way to prove. A spend passes `spendKeys`, which also satisfies this.
   */
  readonly keys: ShieldedKeys;
  /**
   * Whether an incomplete read is fatal. True on the spend path: a partial read
   * might offer a note another operation already spent, or hide the one that
   * covered the amount. Reporting a balance survives that as `degraded`;
   * choosing what to spend does not.
   */
  readonly requireComplete: boolean;
  /**
   * Slot the indexer must reach before its answers are used. Photon trails the
   * chain, so without this a read taken just after a transaction lands
   * describes a moment before it existed.
   */
  readonly requireSlot?: bigint;
}

export interface HydratedWallet {
  readonly wallet: Wallet;
  readonly report: SdkSyncReport;
}

export type SdkSyncAnomaly = Exclude<keyof SdkSyncReport, "storedUtxos">;
export type SyncAnomalyCounts = Record<SdkSyncAnomaly, number>;

/** Exhaustive: a new Zolana report field fails typechecking until it is mapped. */
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

export async function hydrateWallet(input: HydrateWalletInput): Promise<HydratedWallet> {
  // Cache is the single point of entry: read and spend paths share one Wallet
  // per identity so cursors, decrypted state, and freshly-observed nullifiers
  // advance in place across every call, not just within one flow.
  const identity = input.keys.address();
  const fingerprint = canonicalShieldedIdentity(identity);
  const cached = getCachedWallet(input.walletId, fingerprint);
  const wallet = cached ?? new Wallet({ identity });

  const report = await syncWallet({
    wallet,
    keys: input.keys,
    client: input.client,
    ...(input.requireSlot === undefined ? {} : { config: { requireSlot: input.requireSlot } }),
  });
  const anomalies = syncAnomalyCounts(report);

  if (input.requireComplete && hasSyncAnomalies(anomalies)) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      `the wallet could not be read completely (${anomalies.unparsedTransactions} unparsed, ${anomalies.undecryptableCandidates} undecryptable, ${anomalies.unknownAssetIds} unknown asset ids, ${anomalies.unknownAssetFields} unknown asset fields); refusing to select notes`
    );
  }

  if (cached === undefined) setCachedWallet(input.walletId, wallet, fingerprint);

  return { wallet, report };
}
