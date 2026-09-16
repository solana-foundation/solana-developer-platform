import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  PrivateTransaction,
  PrivateTransactionDirection,
  PrivateTransactionKind,
  SyncReport as SdkSyncReport,
  Wallet,
} from "@heliuslabs/zolana/transaction";
import { getPrivateTransactions } from "@heliuslabs/zolana/wallet";
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
import { readKeys } from "./keys.js";
import { assertProvisionedIdentity, type ShieldedMaterialSource } from "./material.js";
import { hasSyncAnomalies, hydrateWallet, syncAnomalyCounts } from "./wallet.js";

/**
 * Reads a wallet's shielded state from Photon.
 *
 * Always a full sync, because nothing here persists a read position. Zolana
 * 0.1.6 added one — `SerializedWalletState` now carries a cursor per stream,
 * and `syncPersistedWallet` commits it with the sync — so this is now a choice
 * rather than a limitation, and lifting it needs somewhere durable and
 * encrypted to keep the snapshot.
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
  // Notes moving into a ring. It spends the wallet's own notes rather than
  // depositing public funds, so it is a transfer here and not a shield.
  ringEntry: "transfer",
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
      const keys = readKeys(material);
      let wallet: Wallet;
      let report: SdkSyncReport;
      try {
        ({ wallet, report } = await hydrateWallet({
          walletId: input.walletId,
          client: deps.client,
          keys,
          requireComplete: false,
          ...(input.requireSlot ? { requireSlot: BigInt(input.requireSlot) } : {}),
        }));
      } finally {
        keys.destroy();
      }

      const labels = assetLabels(input.knownAssets ?? []);
      const transactions = getPrivateTransactions(wallet);
      const { balances, unspentNotes } = perRingBalances(wallet, labels);

      return {
        balances,
        history: transactions.map(toHistoryEntry),
        report: toSyncReport(unspentNotes, report),
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

const byString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Empty string sorts before every base58 id, keeping the default bucket first. */
const ringKey = (ring: string | null): string => ring ?? "";

/**
 * One balance per (ring, mint) over unspent notes. One wallet's notes mix
 * unbound and ring-bound entries; default spend paths reach only unbound notes
 * and a ring's flows only its own, so merging them (as the SDK's own balance
 * read does) would overstate every spendable position. Default bucket first,
 * then rings by id, mints ascending — a deterministic order the dashboard's
 * adjacent-run grouping relies on. Counts the unspent notes it already visits,
 * so the report does not pay `wallet.utxos()`'s per-note deep snapshot twice.
 */
function perRingBalances(
  wallet: Wallet,
  labels: Map<string, KnownAsset>
): { balances: AssetBalance[]; unspentNotes: number } {
  const perRing = new Map<string | null, Map<string, Position>>();
  let unspentNotes = 0;
  for (const entry of wallet.utxos()) {
    if (entry.spent) {
      continue;
    }
    unspentNotes += 1;
    const ring = entry.utxo.ringProgramId ?? null;
    let perMint = perRing.get(ring);
    if (!perMint) {
      perMint = new Map<string, Position>();
      perRing.set(ring, perMint);
    }
    const position = perMint.get(entry.utxo.asset);
    perMint.set(entry.utxo.asset, {
      amount: (position?.amount ?? 0n) + entry.utxo.amount,
      // Fragmentation is only visible per position: the wallet-wide
      // `storedNotes` cannot say which balance a merge would help.
      notes: (position?.notes ?? 0) + 1,
    });
  }

  const balances = [...perRing.entries()]
    .sort(([left], [right]) => byString(ringKey(left), ringKey(right)))
    .flatMap(([ring, perMint]) =>
      [...perMint.entries()]
        .sort(([left], [right]) => byString(left, right))
        .map(([mint, position]) => toAssetBalance(mint, position, labels, ring))
    );
  return { balances, unspentNotes };
}

/** One (ring, mint) position: what it holds and across how many notes. */
interface Position {
  readonly amount: bigint;
  readonly notes: number;
}

function toAssetBalance(
  reportedMint: string,
  position: Position,
  labels: Map<string, KnownAsset>,
  ringProgramId: string | null
): AssetBalance {
  const mint = sdpMint(reportedMint);
  const label = labels.get(mint);

  return {
    mint,
    symbol: label?.symbol ?? "UNKNOWN",
    decimals: label?.decimals ?? 0,
    amountRaw: position.amount.toString(),
    ringProgramId,
    noteCount: position.notes,
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
