import { parseDecimalAmount } from "@sdp/solana/amount";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import type { VaultDeadline } from "@/services/earn/vault-deadline";

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
  open_withdrawal_request_ids: readonly string[];
  redemption_intermediates: readonly ReconcilableRedemptionIntermediate[];
}

/**
 * What one claim's operator redemptions account for in the wallet for one
 * intermediate mint (Hastra wYLDS), in decimal token units: `retained` by
 * cancelled share-sourced requests, less fulfilled or open held-intermediate
 * requests (cancelling held intermediate adds no new backing), `in_flight`
 * delegated by landed open requests, and `unresolved` for requests that may or
 * may not hold theirs (not yet landed, or closed with no identified outcome).
 */
export interface ReconcilableRedemptionIntermediate {
  mint: string;
  retained: string;
  in_flight: string;
  unresolved: string;
}

export interface ReconcilableShareMintedStrategy {
  id: string;
  provider: string;
  provider_reference: string;
  name: string;
  share_mint: string | null;
  status: string;
  created_at: string;
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
  /**
   * True when more than one catalogued vault identity claims this share mint,
   * so the attribution above is the best candidate rather than the only one.
   * `share_mint` carries no uniqueness rule, and a paused or deprecated row
   * stays in the inventory next to its re-listed successor.
   */
  ambiguousAttribution: boolean;
}

export interface UnbackedVaultPosition {
  positionId: string;
  custodyWalletId: string;
  walletAddress: string;
  provider: string;
  vaultAddress: string | null;
  shareMint: string | null;
  label: string;
  /**
   * True when the wallet holds intermediate a cancelled operator redemption on
   * this claim may have left, but an unresolved request or another claim's
   * redemption could own it, so the report cannot tell whether it backs this
   * claim.
   */
  ambiguousBacking: boolean;
}

/**
 * A zero-share claim with open queued withdrawal requests. The requests
 * escrowed or burned shares ahead of the payout, but only the shares they
 * cover, and the ledger holds no per-claim share total to check that
 * against, so the claim is listed beside its requests rather than judged.
 */
export interface QueuedWithdrawalVaultPosition extends UnbackedVaultPosition {
  withdrawalRequestIds: string[];
}

export interface UnreadableVaultWallet {
  custodyWalletId: string;
  walletAddress: string;
}

export interface VaultShareReconciliationReport {
  unrecordedHoldings: UnrecordedVaultHolding[];
  unbackedPositions: UnbackedVaultPosition[];
  queuedWithdrawalPositions: QueuedWithdrawalVaultPosition[];
  unreadableWallets: UnreadableVaultWallet[];
}

/** Same bound the positions hydration fan-out uses for per-owner reads. */
const BALANCE_READ_CONCURRENCY = 8;

type VaultShareBalances = Awaited<ReturnType<VaultShareBalanceReader>>;

type IntermediateBacking = "backed" | "ambiguous" | "none";

const atomsOf = (amount: string): bigint => (/^\d+$/.test(amount) ? BigInt(amount) : 0n);

const isPositiveDecimal = (amount: string): boolean => /[1-9]/.test(amount);

/** Ledger decimals summed in the mint's atoms; null when one cannot be read at that scale. */
function sumAtoms(mint: string, amounts: readonly string[], decimals: number): bigint | null {
  let total = 0n;
  for (const amount of amounts) {
    try {
      total += parseDecimalAmount(amount, decimals);
    } catch (error) {
      getLogger().warn(
        { mint, amount, decimals, error },
        "share reconciliation could not read a redemption's intermediate amount"
      );
      return null;
    }
  }
  return total;
}

/**
 * Whether each intermediate mint in one wallet backs the claims whose
 * cancelled operator redemptions left it. Landed open requests own what they
 * delegated. What remains backs a sole retaining claim outright, even if every
 * unresolved request's amount is there too: presence, like the share rule, so
 * one atom backs it and a mostly drained claim reads as backed. Claims sharing
 * the mint need it to cover all of them. Anything short of certain is
 * `ambiguous`, never a guess.
 */
function intermediateBacking(
  claims: readonly ReconcilableVaultClaim[],
  balances: VaultShareBalances
): Map<string, IntermediateBacking> {
  const ledger = new Map<
    string,
    { retained: string[]; delegated: string[]; unresolved: string[] }
  >();
  for (const claim of claims) {
    for (const intermediate of claim.redemption_intermediates) {
      const entry = ledger.get(intermediate.mint) ?? {
        retained: [],
        delegated: [],
        unresolved: [],
      };
      if (isPositiveDecimal(intermediate.retained)) entry.retained.push(intermediate.retained);
      entry.delegated.push(intermediate.in_flight);
      entry.unresolved.push(intermediate.unresolved);
      ledger.set(intermediate.mint, entry);
    }
  }

  const backing = new Map<string, IntermediateBacking>();
  for (const [mint, entry] of ledger) {
    const balance = balances.find((candidate) => candidate.mint === mint);
    const held = balance ? atomsOf(balance.amount) : 0n;
    if (!balance || held === 0n) {
      backing.set(mint, "none");
      continue;
    }
    const delegated = sumAtoms(mint, entry.delegated, balance.decimals);
    const unresolved = sumAtoms(mint, entry.unresolved, balance.decimals);
    const needed =
      entry.retained.length > 1 ? sumAtoms(mint, entry.retained, balance.decimals) : 1n;
    if (delegated === null || unresolved === null || needed === null) {
      backing.set(mint, "ambiguous");
      continue;
    }
    const free = held - delegated;
    if (free <= 0n) backing.set(mint, "none");
    else if (free - unresolved >= needed) backing.set(mint, "backed");
    else backing.set(mint, "ambiguous");
  }
  return backing;
}

/**
 * One wallet's judgeable claims that hold none of their shares and that no
 * intermediate a cancelled operator redemption left provably backs, in claim
 * order, each flagged when its backing cannot be decided.
 */
function claimsWithoutBacking(
  claims: readonly ReconcilableVaultClaim[],
  balances: VaultShareBalances
): Array<{ claim: ReconcilableVaultClaim; ambiguous: boolean }> {
  const heldMints = new Set(balances.map((balance) => balance.mint));
  const backing = intermediateBacking(claims, balances);
  const findings: Array<{ claim: ReconcilableVaultClaim; ambiguous: boolean }> = [];
  for (const claim of claims) {
    // A claim without a share mint cannot be judged against balances, and an
    // in-flight movement already explains a chain/record disagreement — the
    // sweep settles it within about a minute either way.
    if (!claim.share_mint || claim.has_unsettled_movements) continue;
    if (heldMints.has(claim.share_mint)) continue;
    // A cancelled redemption left its intermediate in place of the shares.
    const verdicts = claim.redemption_intermediates
      .filter((intermediate) => isPositiveDecimal(intermediate.retained))
      .map((intermediate) => backing.get(intermediate.mint) ?? "none");
    if (verdicts.includes("backed")) continue;
    findings.push({ claim, ambiguous: verdicts.includes("ambiguous") });
  }
  return findings;
}

/**
 * All catalogue rows claiming one share mint, with the attribution the report
 * names resolved up front: an `active` row beats a paused or deprecated one
 * (the live catalogue truth beats a predecessor kept for its operator record),
 * newest first within a status, id as the total-order tiebreak. The holding is
 * flagged ambiguous only when the candidates disagree on the VAULT identity
 * (provider + reference): a re-listed vault leaves two rows for one identity,
 * and that is a superseded row, not an ambiguous mint.
 */
function resolveShareMintAttributions(
  strategies: ReadonlyArray<ReconcilableShareMintedStrategy>
): Map<string, { attributed: ReconcilableShareMintedStrategy; ambiguous: boolean }> {
  const candidatesByMint = new Map<string, ReconcilableShareMintedStrategy[]>();
  for (const strategy of strategies) {
    if (!strategy.share_mint) continue;
    const candidates = candidatesByMint.get(strategy.share_mint);
    if (candidates) candidates.push(strategy);
    else candidatesByMint.set(strategy.share_mint, [strategy]);
  }

  const attributions = new Map<
    string,
    { attributed: ReconcilableShareMintedStrategy; ambiguous: boolean }
  >();
  for (const [mint, candidates] of candidatesByMint) {
    const ranked = [...candidates].sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return b.id.localeCompare(a.id);
    });
    const attributed = ranked[0];
    if (!attributed) continue;
    const identities = new Set(
      candidates.map((candidate) => `${candidate.provider}\n${candidate.provider_reference}`)
    );
    attributions.set(mint, { attributed, ambiguous: identities.size > 1 });
  }
  return attributions;
}

export async function reconcileVaultShareHoldings(input: {
  wallets: ReadonlyArray<ReconcilableVaultWallet>;
  claims: ReadonlyArray<ReconcilableVaultClaim>;
  strategies: ReadonlyArray<ReconcilableShareMintedStrategy>;
  readBalances: VaultShareBalanceReader;
  /**
   * One absolute budget for the whole pass. The wallet count is data-driven,
   * so without this a large tenant turns the endpoint into unbounded
   * request-length RPC waves; with it, a wallet whose read cannot start or
   * finish inside the budget lands in `unreadableWallets` (claims unjudged),
   * never a hung request and never a silently skipped wallet.
   */
  deadline: VaultDeadline;
}): Promise<VaultShareReconciliationReport> {
  const strategiesByShareMint = resolveShareMintAttributions(input.strategies);

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
    queuedWithdrawalPositions: [],
    unreadableWallets: [],
  };

  const wallets = [...input.wallets];
  const settled = await mapSettledWithConcurrency(wallets, BALANCE_READ_CONCURRENCY, (wallet) =>
    input.deadline.run(`vault share balance read for ${wallet.publicKey}`, () =>
      input.readBalances(wallet.publicKey)
    )
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

    const recordedShareMints = new Set(
      walletClaims.map((claim) => claim.share_mint).filter((mint) => mint !== null)
    );

    for (const balance of outcome.value) {
      const attribution = strategiesByShareMint.get(balance.mint);
      if (!attribution || recordedShareMints.has(balance.mint)) continue;
      report.unrecordedHoldings.push({
        custodyWalletId: wallet.id,
        walletAddress: wallet.publicKey,
        provider: attribution.attributed.provider,
        strategyId: attribution.attributed.id,
        strategyName: attribution.attributed.name,
        vaultAddress: attribution.attributed.provider_reference,
        shareMint: balance.mint,
        shares: balance.amount,
        decimals: balance.decimals,
        uiShares: balance.uiAmount,
        ambiguousAttribution: attribution.ambiguous,
      });
    }

    for (const { claim, ambiguous } of claimsWithoutBacking(walletClaims, outcome.value)) {
      const finding: UnbackedVaultPosition = {
        positionId: claim.id,
        custodyWalletId: wallet.id,
        walletAddress: wallet.publicKey,
        provider: claim.provider,
        vaultAddress: claim.vault_address,
        shareMint: claim.share_mint,
        label: claim.label,
        ambiguousBacking: ambiguous,
      };
      if (claim.open_withdrawal_request_ids.length > 0) {
        report.queuedWithdrawalPositions.push({
          ...finding,
          withdrawalRequestIds: [...claim.open_withdrawal_request_ids],
        });
      } else {
        report.unbackedPositions.push(finding);
      }
    }
  });

  return report;
}
