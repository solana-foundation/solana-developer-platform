import { SOL_MINT, Wallet } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  PrivateTransaction,
  PrivateTransactionDirection,
  PrivateTransactionKind,
  SyncReport as SdkSyncReport,
  SyncWalletAuthority,
  WalletAuthority,
} from "@heliuslabs/zolana/transaction";
import {
  getPrivateTokenBalances,
  getPrivateTransactions,
  syncWallet,
} from "@heliuslabs/zolana/wallet";
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
import { assertShieldedIdentity, type ShieldedMaterialSource } from "./material.js";

/**
 * Reads a wallet's shielded state from Photon.
 *
 * Always a full sync. The SDK keeps three independent read positions and warns
 * that reaching the tip of one says nothing about the others, so there is no
 * cursor to resume from and pretending otherwise would silently skip rows.
 */

/**
 * SDP's pseudo-mint for native SOL is wrapped SOL; the protocol's is the system
 * program. Neither side is wrong, so the two are translated here, at the one
 * boundary that touches both, rather than teaching either side the other's
 * spelling.
 */
// biome-ignore lint/security/noSecrets: the wrapped SOL mint, a public constant.
const SDP_NATIVE_MINT = "So11111111111111111111111111111111111111112";
const PROTOCOL_NATIVE_MINT: string = SOL_MINT;

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
        assertShieldedIdentity(material, input.expectedShieldedAddress);
      }

      const wallet = new Wallet({ identity: material.shieldedAddress });

      // `syncWallet` is typed against the full `WalletAuthority` but only ever
      // calls `syncMaterial`, and the SDK names that narrower contract itself.
      // Reading therefore gets an authority that can do nothing else; building
      // a spending authority here would have meant inventing an approval for an
      // operation that does not exist. The cast is to the wider parameter type,
      // and a future SDK that really did spend during a sync would fail loudly
      // on a missing method rather than sign something unapproved.
      const readOnly: SyncWalletAuthority = {
        syncMaterial: async () => ({
          identity: material.shieldedAddress,
          viewingKeys: [material.viewingKey],
          nullifierKey: material.nullifierKey,
        }),
      };

      const report = await syncWallet({
        wallet,
        authority: readOnly as WalletAuthority,
        client: deps.client,
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
      };
    }
  );
}

function assetLabels(known: readonly KnownAsset[]): Map<string, KnownAsset> {
  return new Map(known.map((asset) => [asset.mint, asset]));
}

function toAssetBalance(
  protocolMint: string,
  amount: bigint,
  labels: Map<string, KnownAsset>
): AssetBalance {
  const mint = protocolMint === PROTOCOL_NATIVE_MINT ? SDP_NATIVE_MINT : protocolMint;
  const label = labels.get(mint);

  return {
    mint,
    // An unknown mint keeps its raw amount and says so. Guessing nine decimals
    // would render a real holding at the wrong magnitude, which is worse than
    // an unlabelled row.
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
    mint: entry.asset === PROTOCOL_NATIVE_MINT ? SDP_NATIVE_MINT : entry.asset,
    amountRaw: entry.amount.toString(),
  };
}

/**
 * A sync that could not read everything still returns balances, so `degraded`
 * is what stops those partial balances being read as a complete picture.
 */
function toSyncReport(storedNotes: number, report: SdkSyncReport): SyncReport {
  return {
    storedNotes,
    unparsedTransactions: report.unparsedTransactions,
    undecryptableCandidates: report.undecryptableCandidates,
    degraded: report.unparsedTransactions > 0 || report.undecryptableCandidates > 0,
  };
}
