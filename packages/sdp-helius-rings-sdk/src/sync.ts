import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  PrivateTransaction,
  PrivateTransactionDirection,
  PrivateTransactionKind,
  SyncReport as SdkSyncReport,
} from "@heliuslabs/zolana/transaction";
import { getPrivateTokenBalances, getPrivateTransactions } from "@heliuslabs/zolana/wallet";
import type {
  AssetBalance,
  KnownAsset,
  PrivateHistoryDirection,
  PrivateHistoryEntry,
  PrivateHistoryKind,
  SyncPhotonInput,
  SyncPhotonResult,
  SyncReport,
} from "@sdp/helius-rings";
import { sdpMint } from "./flows/mint.js";
import { assertProvisionedIdentity, type ShieldedMaterialSource } from "./material.js";
import { hasSyncAnomalies, hydrateWallet, readOnlyAuthority, syncAnomalyCounts } from "./wallet.js";

/**
 * Reads a wallet's shielded state from Photon.
 *
 * Always a full sync. The SDK keeps three independent read positions and warns
 * that reaching the tip of one says nothing about the others, so there is no
 * cursor to resume from and pretending otherwise would silently skip rows.
 */

/**
 * Keyed on the SDK's own unions rather than on `string`, so a variant added
 * upstream is a build failure here instead of a row silently relabelled. The
 * difference matters: a withdrawal shown as a transfer, or an outbound payment
 * shown as inbound, is a wrong answer rather than a missing one.
 */
const HISTORY_KINDS: Record<PrivateTransactionKind, PrivateHistoryKind> = {
  deposit: "shield",
  privateTransfer: "transfer",
  publicWithdrawal: "withdraw",
  merge: "merge",
  split: "split",
};

const HISTORY_DIRECTIONS: Record<PrivateTransactionDirection, PrivateHistoryDirection> = {
  inbound: "inbound",
  outbound: "outbound",
  selfTransfer: "self",
};

export interface SyncDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  readonly organizationId: string;
  readonly projectId: string;
}

export async function syncRingsWallet(
  deps: SyncDeps,
  input: SyncPhotonInput
): Promise<SyncPhotonResult> {
  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: input.walletId,
      owner: input.owner,
    },
    async (material) => {
      if (input.expectedShieldedAddress) {
        assertProvisionedIdentity(material, input.expectedShieldedAddress);
      }

      // Tolerant of an incomplete read, unlike the spend path: partial balances
      // are still worth reporting as long as `degraded` says so.
      const { wallet, report } = await hydrateWallet({
        walletId: input.walletId,
        client: deps.client,
        material,
        authority: readOnlyAuthority(material),
        requireComplete: false,
        ...(input.requireSlot ? { requireSlot: BigInt(input.requireSlot) } : {}),
      });

      const labels = assetLabels(input.knownAssets ?? []);
      const transactions = getPrivateTransactions(wallet);

      return {
        balances: getPrivateTokenBalances(wallet).map((balance) =>
          toAssetBalance(balance.mint, balance.amount, labels)
        ),
        history: transactions.map(toHistoryEntry),
        report: toSyncReport(wallet.utxos().filter((entry) => !entry.spent).length, report),
        // Photon is queried by view tag and nullifier, not by outer signature,
        // so the signatures a sync observed are the ones its history rows were
        // reconstructed from.
        indexedOperationSignatures: [...new Set(transactions.map((entry) => entry.id.signature))],
        observedAt: new Date().toISOString(),
        ...highestSlot(transactions),
      };
    }
  );
}

/**
 * The furthest point this sync actually saw, for the next read to gate on.
 *
 * Absent for a wallet with no history: there is no position to wait for, and
 * claiming one would make the next read wait for a slot nothing produced.
 */
function highestSlot(transactions: readonly PrivateTransaction[]): { observedSlot?: string } {
  if (transactions.length === 0) return {};

  const highest = transactions.reduce(
    (max, entry) => (entry.id.slot > max ? entry.id.slot : max),
    transactions[0].id.slot
  );
  return { observedSlot: highest.toString() };
}

function assetLabels(known: readonly KnownAsset[]): Map<string, KnownAsset> {
  return new Map(known.map((asset) => [asset.mint, asset]));
}

function toAssetBalance(
  reportedMint: string,
  amount: bigint,
  labels: Map<string, KnownAsset>
): AssetBalance {
  const mint = sdpMint(reportedMint);
  const label = labels.get(mint);

  return {
    mint,
    symbol: label?.symbol ?? "UNKNOWN",
    decimals: label?.decimals ?? 0,
    amountRaw: amount.toString(),
  };
}

function toHistoryEntry(entry: PrivateTransaction): PrivateHistoryEntry {
  return {
    signature: entry.id.signature,
    slot: entry.id.slot.toString(),
    index: entry.id.index.toString(),
    kind: HISTORY_KINDS[entry.kind],
    direction: HISTORY_DIRECTIONS[entry.direction],
    mint: sdpMint(entry.asset),
    amountRaw: entry.amount.toString(),
  };
}

/**
 * A sync that could not read everything still returns balances, so `degraded`
 * is what stops those partial balances being read as a complete picture.
 */
function toSyncReport(storedNotes: number, report: SdkSyncReport): SyncReport {
  const anomalies = syncAnomalyCounts(report);

  return {
    storedNotes,
    ...anomalies,
    degraded: hasSyncAnomalies(anomalies),
  };
}
