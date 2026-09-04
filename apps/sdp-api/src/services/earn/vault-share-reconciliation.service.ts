import { mapSettledWithConcurrency } from "@/lib/concurrency";

/**
 * Reconcile custody-wallet share balances against recorded vault claims
 * (PRO-1741).
 *
 * REPORT-ONLY by design, in both directions. An unrecorded holding is
 * surfaced, never adopted into `earn_positions`: a custody wallet may be
 * shared by sibling projects through an organization-level config, so an
 * auto-created claim would have to guess attribution, and a scan that writes
 * money records fabricates claims the moment it has a bug. The reverse
 * finding never closes a row for the same reason — reporting is recoverable,
 * a wrong write is not.
 *
 * Failure posture per wallet: an unreadable balance read names the wallet and
 * withdraws every claim it would have judged. Zero-share findings in
 * particular are claims about someone's money that a failed RPC read cannot
 * support (the same rule hydration follows).
 */

/** One wallet's SPL balances; absence of a mint means a zero balance. */
export type VaultShareBalanceReader = (
  ownerAddress: string
) => Promise<ReadonlyArray<{ mint: string; amount: string; decimals: number; uiAmount: string }>>;

export interface ReconcilableVaultWallet {
  /** `custody_wallets.id` (`cwlt_…`) — the id claim rows are scoped by. */
  id: string;
  publicKey: string;
}

export interface ReconcilableVaultClaim {
  id: string;
  custody_wallet_id: string | null;
  provider: string;
  vault_address: string | null;
  share_mint: string | null;
  label: string;
  has_unsettled_movements: boolean;
}

export interface ReconcilableShareMintedStrategy {
  id: string;
  provider: string;
  provider_reference: string;
  name: string;
  share_mint: string | null;
}

export interface UnrecordedVaultHolding {
  custodyWalletId: string;
  walletAddress: string;
  provider: string;
  strategyId: string;
  strategyName: string;
  vaultAddress: string;
  shareMint: string;
  /** Raw share-token amount, base units. */
  shares: string;
  decimals: number;
  uiShares: string;
}

export interface UnbackedVaultPosition {
  positionId: string;
  custodyWalletId: string;
  walletAddress: string;
  provider: string;
  vaultAddress: string | null;
  shareMint: string | null;
  label: string;
}

export interface UnreadableVaultWallet {
  custodyWalletId: string;
  walletAddress: string;
}

export interface VaultShareReconciliationReport {
  unrecordedHoldings: UnrecordedVaultHolding[];
  unbackedPositions: UnbackedVaultPosition[];
  unreadableWallets: UnreadableVaultWallet[];
}

/** Same bound the positions hydration fan-out uses for per-owner reads. */
const BALANCE_READ_CONCURRENCY = 8;

export async function reconcileVaultShareHoldings(input: {
  wallets: ReadonlyArray<ReconcilableVaultWallet>;
  claims: ReadonlyArray<ReconcilableVaultClaim>;
  strategies: ReadonlyArray<ReconcilableShareMintedStrategy>;
  readBalances: VaultShareBalanceReader;
}): Promise<VaultShareReconciliationReport> {
  // First catalogue row wins a mint. Rows are unique per (provider, reference,
  // environment) and one vault mints one share token, so a collision would be
  // a catalogue defect; deterministic first-wins keeps the report stable
  // rather than flapping between attributions.
  const strategiesByShareMint = new Map<string, ReconcilableShareMintedStrategy>();
  for (const strategy of input.strategies) {
    if (strategy.share_mint && !strategiesByShareMint.has(strategy.share_mint)) {
      strategiesByShareMint.set(strategy.share_mint, strategy);
    }
  }

  const claimsByWalletId = new Map<string, ReconcilableVaultClaim[]>();
  for (const claim of input.claims) {
    if (!claim.custody_wallet_id) continue;
    const walletClaims = claimsByWalletId.get(claim.custody_wallet_id);
    if (walletClaims) walletClaims.push(claim);
    else claimsByWalletId.set(claim.custody_wallet_id, [claim]);
  }

  const report: VaultShareReconciliationReport = {
    unrecordedHoldings: [],
    unbackedPositions: [],
    unreadableWallets: [],
  };

  const wallets = [...input.wallets];
  const settled = await mapSettledWithConcurrency(wallets, BALANCE_READ_CONCURRENCY, (wallet) =>
    input.readBalances(wallet.publicKey)
  );

  wallets.forEach((wallet, index) => {
    const outcome = settled[index];
    const walletClaims = claimsByWalletId.get(wallet.id) ?? [];
    if (!outcome || outcome.status === "rejected") {
      report.unreadableWallets.push({
        custodyWalletId: wallet.id,
        walletAddress: wallet.publicKey,
      });
      return;
    }

    const balancesByMint = new Map(outcome.value.map((balance) => [balance.mint, balance]));
    const recordedShareMints = new Set(
      walletClaims.map((claim) => claim.share_mint).filter((mint) => mint !== null)
    );

    for (const balance of outcome.value) {
      const strategy = strategiesByShareMint.get(balance.mint);
      if (!strategy || recordedShareMints.has(balance.mint)) continue;
      report.unrecordedHoldings.push({
        custodyWalletId: wallet.id,
        walletAddress: wallet.publicKey,
        provider: strategy.provider,
        strategyId: strategy.id,
        strategyName: strategy.name,
        vaultAddress: strategy.provider_reference,
        shareMint: balance.mint,
        shares: balance.amount,
        decimals: balance.decimals,
        uiShares: balance.uiAmount,
      });
    }

    for (const claim of walletClaims) {
      // A claim without a share mint cannot be judged against balances, and an
      // in-flight movement already explains a chain/record disagreement — the
      // sweep settles it within about a minute either way.
      if (!claim.share_mint || claim.has_unsettled_movements) continue;
      if (balancesByMint.has(claim.share_mint)) continue;
      report.unbackedPositions.push({
        positionId: claim.id,
        custodyWalletId: wallet.id,
        walletAddress: wallet.publicKey,
        provider: claim.provider,
        vaultAddress: claim.vault_address,
        shareMint: claim.share_mint,
        label: claim.label,
      });
    }
  });

  return report;
}
