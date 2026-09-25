import { Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { SyncReport as SdkSyncReport, ShieldedKeys } from "@heliuslabs/zolana/transaction";
import { syncWallet } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { canonicalShieldedIdentity } from "./material.js";
import { getCachedWallet, invalidateCachedWallet, setCachedWallet } from "./wallet-cache.js";

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

/**
 * Whether Zolana's sync committed cursors past events it never stored.
 *
 * Upstream stages a sync in a session and commits it whenever the scan itself
 * does not throw — and `unparsedTransactions`/`undecryptableCandidates` are
 * reported, not thrown. The commit therefore advances the per-tag cursors
 * beyond events the indexer could not serve, and the wallet's rows for them
 * do not exist. (`unknownAssetIds`/`unknownAssetFields` are different: upstream
 * throws before committing when an asset stays unresolved, so those anomalies
 * never advance anything.)
 */
export function committedPastIncompleteData(report: SdkSyncReport): boolean {
  return report.unparsedTransactions > 0 || report.undecryptableCandidates > 0;
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

  // An incomplete scan commits cursors past the events the indexer could not
  // serve, so this wallet can no longer be the shared resume point: keeping it
  // cached would let the next hydration — a spend's strict validation included
  // — continue beyond the skipped range and never revisit it. Drop the entry
  // instead; the in-memory object still answers the call in progress (reporting
  // stays degraded rather than failing), and the next hydration re-scans the
  // skipped range from the indexer's beginning. This holds for both paths: a
  // refused strict read and a tolerated degraded read leave the cache empty
  // alike, so neither can blind the other.
  const incomplete = committedPastIncompleteData(report);
  if (incomplete) {
    invalidateCachedWallet(input.walletId);
  } else if (cached === undefined) {
    setCachedWallet(input.walletId, wallet, fingerprint);
  }

  if (input.requireComplete && hasSyncAnomalies(anomalies)) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      `the wallet could not be read completely (${anomalies.unparsedTransactions} unparsed, ${anomalies.undecryptableCandidates} undecryptable, ${anomalies.unknownAssetIds} unknown asset ids, ${anomalies.unknownAssetFields} unknown asset fields); refusing to select notes`
    );
  }

  return { wallet, report };
}
