import type { SolanaCluster, WellKnownTokenSymbol } from "./well-known-tokens";
import { WELL_KNOWN_TOKENS } from "./well-known-tokens";

/**
 * Solana Earn (SDP Markets V1) — shared wire contracts.
 *
 * Organizations and wallet integrators browse strategies across DeFi and
 * tokenized RWAs, then prepare provider-built transactions to enter or exit
 * a strategy. Operations track signing, submission and settlement. Durable
 * movements and positions live in SDP's ledger; balances are read live.
 *
 * Registries follow ADR 0001 (asset profiles): closed unions defined in code,
 * open TEXT columns in Postgres, Zod validation at the app layer — adding a
 * new kind is a code change, never a migration.
 */

/**
 * Deposit stablecoins for Earn V1. The PRD set is USDC, USDG, PYUSD
 * (PYUSD admitted for the curated Kamino shelf's two Sentora vaults,
 * PRO-1727); USDT remains from the day-one set and still has catalogued
 * vaults behind it. OUSD is the asset of Veda's mainnet OUSD PRIME vault.
 */
export const EARN_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
  "USDG",
  "USDT",
  "PYUSD",
  "OUSD",
] as const satisfies readonly WellKnownTokenSymbol[];
export type EarnDepositTokenSymbol = (typeof EARN_DEPOSIT_TOKEN_SYMBOLS)[number];

/**
 * Stablecoins a deposit may be FUNDED in, whatever the strategy's own deposit
 * token: when they differ, the deposit transaction gets a Jupiter swap
 * prepended so the vault still receives its own token (PRO: swap-funded
 * deposits). A separate registry from `EARN_DEPOSIT_TOKEN_SYMBOLS` on purpose —
 * that one states what vaults TAKE, this one states what customers may PAY
 * WITH, and the two move independently. OUSD is a vault deposit asset, not a
 * swap funding source. Never derive one list from the other.
 */
export const EARN_SWAP_SOURCE_TOKEN_SYMBOLS = [
  "USDC",
  "USDG",
  "PYUSD",
  "USDT",
] as const satisfies readonly WellKnownTokenSymbol[];
export type EarnSwapSourceTokenSymbol = (typeof EARN_SWAP_SOURCE_TOKEN_SYMBOLS)[number];

/** One cluster's deployment of a swap-source stablecoin, picker-ready. */
export interface EarnSwapSourceToken {
  symbol: EarnSwapSourceTokenSymbol;
  mint: string;
  decimals: number;
}

/**
 * The swap-source stablecoins deployed on one cluster, mint-resolved.
 *
 * Derived from `WELL_KNOWN_TOKENS`, never hand-listed, so a token absent from
 * a cluster (USDT has no devnet mint) simply does not appear rather than
 * appearing with another cluster's address. Order follows
 * `EARN_SWAP_SOURCE_TOKEN_SYMBOLS`, which pickers may rely on.
 */
export function earnSwapSourceTokens(cluster: SolanaCluster): EarnSwapSourceToken[] {
  const tokens: EarnSwapSourceToken[] = [];
  for (const symbol of EARN_SWAP_SOURCE_TOKEN_SYMBOLS) {
    const mints: { readonly [K in SolanaCluster]?: { address: string; decimals: number } } =
      WELL_KNOWN_TOKENS[symbol].mints;
    const mint = mints[cluster];
    if (mint) tokens.push({ symbol, mint: mint.address, decimals: mint.decimals });
  }
  return tokens;
}

/**
 * Default and bounds for the swap leg's slippage tolerance, in basis points.
 * The default is deliberately tight (2 bps): every supported pair is
 * USD-stable on both sides, so a healthy route clears well inside it and the
 * remainder left in the owner's wallet stays negligible. The ceiling is a
 * hard cap the API enforces (1..500): a stable-stable pair that needs more
 * than 5% tolerance is depegging, and moving money into a depegging token
 * silently is not a service.
 */
export const EARN_SWAP_DEFAULT_SLIPPAGE_BPS = 2;
export const EARN_SWAP_MAX_SLIPPAGE_BPS = 500;

export const EARN_STRATEGY_SOURCE_KINDS = ["defi", "rwa"] as const;
export type EarnStrategySourceKind = (typeof EARN_STRATEGY_SOURCE_KINDS)[number];

export const EARN_APY_TYPES = ["variable", "fixed"] as const;
export type EarnApyType = (typeof EARN_APY_TYPES)[number];

export const EARN_LIQUIDITY_TERMS = ["instant", "delayed"] as const;
export type EarnLiquidityTerm = (typeof EARN_LIQUIDITY_TERMS)[number];

export const EARN_STRATEGY_STATUSES = ["active", "paused", "deprecated"] as const;
export type EarnStrategyStatus = (typeof EARN_STRATEGY_STATUSES)[number];

/**
 * Curator/risk metadata surfaced on the strategy catalogue. Curators publish
 * heterogeneous risk frameworks, so this stays an open shape with a few
 * well-known fields the dashboard can render consistently.
 */
export interface EarnStrategyRiskMetadata {
  /** Open curator id — see EARN_KNOWN_CURATOR_LABELS for display mapping. */
  curator?: string;
  riskTier?: string;
  frameworkUrl?: string;
  [key: string]: unknown;
}

export interface EarnStrategySlippagePolicy {
  /** Live quote endpoint must be called before building this direction. */
  quoteRequired: true;
  /** Suggested starting tolerance; the customer may choose another accepted value. */
  defaultToleranceBps: number;
}

export interface EarnStrategy {
  id: string;
  /**
   * Strategy provider ID. Open string on the read model: catalogue rows
   * persist as open TEXT and may reference a provider this deployment no
   * longer (or does not yet) register, so dispatch always resolves fail-closed
   * server-side.
   */
  provider: string;
  /** Provider-side identifier for the strategy. */
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  /** Open string — onboarding a new RWA or protocol is a catalogue change, not a type migration. */
  underlyingSource?: string;
  /** Stablecoin mint addresses accepted for deposit. */
  depositMints: string[];
  /** Mint of the yield-bearing share/receipt token, when the strategy issues one. */
  shareMint?: string;
  apyType: EarnApyType;
  /** Latest observed APY as a decimal string (e.g. "0.062" = 6.2%). */
  currentApy?: string;
  liquidityTerm: EarnLiquidityTerm;
  /** Days until a redemption settles, for delayed-liquidity strategies. */
  redemptionDelayDays?: number;
  riskMetadata?: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  /** Null when this provider's deposit builder needs no quote-derived floor. */
  depositSlippage: EarnStrategySlippagePolicy | null;
  /** Null when this provider's withdrawal builder needs no quote-derived floor. */
  withdrawalSlippage: EarnStrategySlippagePolicy | null;
  /**
   * The cluster the strategy's INSTRUMENT actually lives on — not the cluster
   * of the environment that catalogued it, and the two can differ.
   *
   * A provider may front instruments that do not exist on every cluster, so a
   * row can name a live mainnet vault while sitting in a sandbox catalogue:
   * everything about it true, none of it fundable from devnet. Since PRO-1742
   * that is a designed steady state rather than drift — a non-production
   * environment stores a browse-only MIRROR of the production mainnet shelf
   * beside its own cluster's rows, so the curated catalogue can be reviewed
   * outside production. List reads default to the environment's own cluster
   * and serve the mirrored shelf only on an explicit `?cluster=` opt-in;
   * either way, this field plus `fundable` below are what keep a mirrored row
   * honest.
   *
   * `status: "active"` cannot express that — it is the operator's stop switch,
   * and reusing it here would both lie about why and collide with the
   * repository's refusal to overwrite an operator pause. So the row states the
   * cluster and every gate reads it. `fundable` below is the derived answer
   * callers should branch on.
   */
  hostCluster: SolanaCluster;
  /**
   * Whether this strategy's instrument exists on **the caller's environment's
   * cluster** — derived per request from `hostCluster`, never stored.
   *
   * `false` is the load-bearing half and is definitive: the instrument does not
   * exist on your cluster, so a deposit cannot succeed. Read it rather than
   * assuming a listed strategy is fundable — the catalogue lists what EXISTS,
   * which is a larger set.
   *
   * `true` is necessary but NOT sufficient. It answers only the cluster
   * question; a deposit additionally needs the matching execution capability,
   * an open environment, an active strategy, and organization entitlement.
   * Those are deliberately not folded in here: this field describes the
   * INSTRUMENT, and entitlement in particular is a property of the caller, not
   * of a platform-global catalogue row.
   */
  fundable: boolean;
  /**
   * Whether SDP's treasury vault flow would pay the network fee (and any
   * share-ATA rent) for a movement on this strategy from **the caller's
   * environment**, derived per request and never stored, like `fundable`.
   *
   * This is the SAME gate execution applies (`resolveVaultSponsorship`), so it
   * is the field a client reads for honest fee copy. It deliberately does not
   * ride on the deposit quote: providers with no quote-derived floor (Kamino)
   * never fetch a quote, and a flag that only travels with one is unreadable
   * exactly for them. Always `false` when not `fundable`. A swap-funded deposit
   * is wallet-pays regardless; the swap choice is the client's, so the client
   * applies that override.
   */
  feeSponsored: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A par-redemption intermediate the owner holds outside any open request, such
 * as Hastra wYLDS after a cancelled par request. It belongs to the position:
 * the holding is not empty while it is non-zero.
 */
export interface EarnVaultPositionIntermediate {
  mint: string;
  amount: string;
  /** "0" while the provider has frozen the account. */
  withdrawableAmount: string;
  /** Value in the position's deposit token (`tokenMint`). */
  tokenValue: string;
}

const CANONICAL_ZERO_DECIMAL = /^0+(\.0+)?$/;

/**
 * Whether a live-read vault holding is empty. Every close-out and the
 * dashboard's open-position filter use this one rule, so a position whose
 * shares are gone but whose par intermediate remains is never retired or
 * hidden. Anything but a canonical zero reads as non-empty.
 */
export function isEarnVaultHoldingEmpty(holding: {
  shares: string;
  parIntermediate?: Pick<EarnVaultPositionIntermediate, "amount">;
}): boolean {
  return (
    CANONICAL_ZERO_DECIMAL.test(holding.shares) &&
    (holding.parIntermediate === undefined ||
      CANONICAL_ZERO_DECIMAL.test(holding.parIntermediate.amount))
  );
}

/**
 * Non-custodial vault positions — the custody wallet owns the vault shares and
 * SDP reads their current value live from the provider on every list request.
 */
export interface EarnVaultPosition {
  id: string;
  provider: string;
  providerReference: string;
  label: string;
  custodyWalletId: string;
  tokenMint: string;
  shareMint: string;
  createdAt: string;
  closedAt: string | null;
  /**
   * Whether SDP would pay the network fee for a withdrawal from this position:
   * the execution gate (`resolveVaultSponsorship`) answered per request for the
   * caller's environment, so the exit copy never depends on a quote the
   * provider may not offer. See `EarnStrategy.feeSponsored`.
   */
  feeSponsored: boolean;
  /** Absent when the provider read failed; never coerce an unavailable value to zero. */
  shares?: string;
  /** Unstaked shares immediately redeemable through SDP; absent when unreadable. */
  withdrawableShares?: string;
  /**
   * Unix epoch seconds when provider-locked shares become eligible to exit.
   * Absent when no lock applies or when live provider state is unavailable.
   */
  unlockTimestamp?: string | null;
  /**
   * Value of the position in the deposit token (`tokenMint`), as the provider reports it:
   * shares × rate for rate-based vaults, an exit quote for the whole position for quote-based
   * providers (Veda, Ondo), so it does not scale to other share amounts. A deposit-token
   * amount, not a share count and not a USD conversion. Every Earn deposit token is a USD
   * stablecoin, so at par this is a dollar figure. Absent when the provider cannot hydrate the
   * position.
   */
  tokenValue?: string;
  /** Present only while the owner holds a par intermediate outside an open request. */
  parIntermediate?: EarnVaultPositionIntermediate;
}

export interface EarnVaultPositionsPage {
  positions: EarnVaultPosition[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Present when afterMovementIds constrained reads of their affected positions. */
  balanceReadContext?: { afterMovementIds: string[]; minimumSlot: number };
}

/** One live position held by a partner end user's wallet. */
export interface EarnWalletPosition {
  id: string;
  ownerAddress: string;
  provider: string;
  providerReference: string;
  label: string;
  tokenMint: string;
  shareMint: string;
  createdAt: string;
  closedAt: string | null;
  /** Absent when the live provider read failed; unavailable is never encoded as zero. */
  shares?: string;
  /** Absent when the live provider read failed. */
  withdrawableShares?: string;
  /** Unix epoch seconds when provider-locked shares become eligible to exit, when applicable. */
  unlockTimestamp?: string | null;
  /**
   * Provider-reported value of the shares in the deposit token (`tokenMint`), by rate or by
   * exit quote: a dollar figure at par, never a share count. Absent when the live provider
   * read failed.
   */
  tokenValue?: string;
  /** Present only while the owner holds a par intermediate outside an open request. */
  parIntermediate?: EarnVaultPositionIntermediate;
}

export interface EarnWalletTokenTotal {
  tokenMint: string;
  walletCount: number;
  positionCount: number;
  unavailablePositionCount: number;
  /**
   * Sum of the positions' `tokenValue` plus any par intermediate's value, in `tokenMint`, a
   * dollar figure at par. Absent when any contributing position is unavailable, so the total
   * is never partial.
   */
  tokenValue?: string;
}

export interface EarnWalletStrategyTotal {
  provider: string;
  providerReference: string;
  label: string;
  /**
   * Exact project-scoped owners contributing to this strategy total. ABSENT by
   * default; present only when the caller passed `includeOwnerAddresses=true`
   * (PRO-1873 added the flag, PRO-1908 made omission the default). This is the
   * end-user address book of the whole project, so only a surface that renders
   * per-customer detail should opt in.
   */
  ownerAddresses?: string[];
  /**
   * Complete live positions contributing to this strategy total. Present only
   * when the caller passes `includePositions=true` alongside
   * `includeOwnerAddresses=true`; absent from totals-only responses so
   * analytics consumers do not receive per-customer details.
   */
  positions?: EarnWalletPosition[];
  walletCount: number;
  positionCount: number;
  totalsByToken: EarnWalletTokenTotal[];
}

/** Complete live aggregate for one partner project across its end-user wallets. */
export interface EarnWalletPositionSummary {
  walletCount: number;
  positionCount: number;
  unavailablePositionCount: number;
  totalsByStrategy: EarnWalletStrategyTotal[];
  totalsByToken: EarnWalletTokenTotal[];
}

export const EARN_VAULT_MOVEMENT_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
] as const;
export type EarnVaultMovementStatus = (typeof EARN_VAULT_MOVEMENT_STATUSES)[number];

/** Durable result of a submitted vault deposit (fresh or idempotently replayed). */
export interface EarnVaultDeposit {
  /** Verified cross-chain fulfillment; cancelled means shares returned and no USDC payout. */
  settlementOutcome?: "delivered" | "cancelled";
  positionId: string;
  movementId: string;
  status: EarnVaultMovementStatus;
  signature: string;
  failureReason: string | null;
  replayed: boolean;
  strategy: {
    id: string;
    name: string;
    provider: string;
    providerReference: string;
    hostCluster: SolanaCluster;
  };
}

/**
 * One recorded vault deposit, read back by movement id — what a caller polls
 * to learn whether a signed deposit actually landed.
 *
 * Every field comes off the movement row ITSELF, with no catalogue join. That
 * is deliberate: a strategy can be un-catalogued (paused, dropped by the sync,
 * or belonging to a provider SDP stopped offering) while the deposit it funded
 * is still in flight, and ADR 0002's exit-safety rule says reading money the
 * organization already holds must never depend on the provider still being
 * offered. `provider`/`providerReference` name the vault; the strategy's
 * display name is the caller's to remember, and losing it must not cost the
 * customer the outcome of a signed transaction.
 *
 * No `replayed`: that answers "did your idempotency key already spend itself",
 * which is a property of a WRITE, not of the row.
 */
export interface EarnVaultDepositRecord {
  /** Verified cross-chain fulfillment; cancelled means shares returned and no USDC payout. */
  settlementOutcome?: "delivered" | "cancelled";
  movementId: string;
  positionId: string;
  provider: string;
  providerReference: string;
  status: EarnVaultMovementStatus;
  signature: string;
  /** Accepted deposit amount, in the vault token's units, as a decimal string. */
  amount: string;
  failureReason: string | null;
  createdAt: string;
  /** Set only once SDP observed the transaction on chain — the detail read's chain read-through or the reconciliation sweep. */
  confirmedAt: string | null;
}

/** One signed vault withdrawal movement. */
export interface EarnVaultWithdrawal {
  redemptionMode?: "standard" | "instant";
  /** Verified cross-chain fulfillment; cancelled means shares returned and no USDC payout. */
  settlementOutcome?: "delivered" | "cancelled";
  movementId: string;
  positionId: string;
  provider: string;
  /** The vault's on-chain address — the instrument, not the payout. */
  providerReference: string;
  /** The wallet that owns the redeemed position — the identity a cancellation acts for. */
  ownerAddress: string | null;
  status: EarnVaultDirectMovementStatus;
  signature: string;
  /** Total shares requested by the caller, decimal string, share units. */
  shares: string;
  shareMint: string;
  failureReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  settledAt: string | null;
  /** Present on POST responses; true when the idempotency anchor was replayed. */
  replayed?: boolean;
}

/** BoringQueue's hard upper bound for a solver window: 90 days. */
export const EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS = 90 * 24 * 60 * 60;

/** One asset's live provider queue limits. These are chain state, never UI defaults. */
export interface EarnVaultQueuedWithdrawalTerms {
  assetMint: string;
  allowWithdrawals: boolean;
  secondsToMaturity: number;
  minimumSecondsToDeadline: number;
  maximumSecondsToDeadline: number;
  minimumDiscountBps: number;
  maximumDiscountBps: number;
  /** Decimal string in vault-share units. */
  minimumShares: string;
  shareDecimals: number;
}

/** Live terms for an operator-completed par redemption. */
export interface EarnVaultParRedemptionTerms {
  intermediateMint: string;
  assetMint: string;
  /** Null while the provider's rate is unavailable, which blocks share-sourced requests. */
  minimumShares: string | null;
  /** Smallest request over intermediate the owner already holds. */
  minimumIntermediateAmount: string;
  shareDecimals: number;
  assetDecimals: number;
  cancelable: boolean;
  operatorSettled: true;
}

/** Independently available exit routes for one owned vault position. */
export interface EarnVaultWithdrawalOptions {
  providerRedemptionModes?: readonly ("standard" | "instant")[];
  positionId: string;
  /** Redeem shares and receive assets atomically in the same transaction. */
  instant: boolean;
  /**
   * Transfer shares into a provider-managed redemption order whose asset payout
   * settles later. Mutually exclusive with `instant`; distinct from `queued`,
   * which is an on-chain request with its own lifecycle and cancellation path.
   */
  providerOrder: boolean;
  queued: boolean;
  /** Queue authority when the provider exposes a queued exit; null for direct-only providers. */
  withdrawAuthority: string | null;
  queueState: string | null;
  queueAsset: EarnVaultQueuedWithdrawalTerms | null;
  /** Independent par-redemption route; null when the provider has none. */
  parRedemption?: EarnVaultParRedemptionTerms | null;
}

/**
 * `pending_approval` is synthesized by the provider client, never reported
 * top-level by the provider: a provider may park the affected payout leg in
 * `pending_customer_approval` (awaiting a customer-side signature) while
 * the withdrawal itself keeps saying `processing`, so the client folds a
 * parked leg up into this distinct status — a withdrawal waiting on an
 * approval must be legible, not an indefinite `processing`.
 */
export const EARN_PORTFOLIO_WITHDRAWAL_STATUSES = [
  "processing",
  "pending_approval",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
] as const;

/**
 * Statuses a withdrawal never moves on from. One declaration for every
 * consumer (API ledger CAS + dashboard outcome polling) — `partially_completed`
 * is terminal by convention; if a provider ever advances it, the live GET keeps
 * serving provider truth while the ledger row stays put.
 */
export const EARN_TERMINAL_WITHDRAWAL_STATUSES = [
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
] as const satisfies readonly (typeof EARN_PORTFOLIO_WITHDRAWAL_STATUSES)[number][];

/**
 * Ledger-row status vocabulary: `requested` is SDP-only pre-provider intent
 * state (the row exists, the provider call has not been accepted yet); every
 * other value is the canonical provider-observed status.
 */
export const EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES = [
  "requested",
  ...EARN_PORTFOLIO_WITHDRAWAL_STATUSES,
] as const;

/**
 * The unified movement ledger (PRO-1705, migration 0062).
 *
 * One vocabulary for every Earn money movement, whichever way it was executed.
 * Earn previously split its movements across two tables by EXECUTION MECHANISM
 * — provider-API withdrawals in one, signed on-chain deposits in the other — so
 * every status, terminal set and transition rule existed twice, in two
 * different shapes, in two different packages.
 *
 * This is the single source of truth for movement BEHAVIOUR: which statuses
 * exist, which are terminal, and which transitions are legal. The database
 * mirrors the first two as rows in `earn_movement_statuses` (so SQL can read
 * the terminal set instead of re-spelling it), and a conformance test asserts
 * the rows equal these constants — a migration and a change here can only move
 * together. Transitions stay here alone: a table cannot enforce them without
 * triggers, and the guards need them at compile time.
 */
export const EARN_EXECUTION_MODELS = ["custodial", "vault_direct"] as const;
export type EarnExecutionModel = (typeof EARN_EXECUTION_MODELS)[number];

/**
 * Spelled `withdrawal`, matching every wire contract, route and dashboard label
 * that already exists. (Migration 0059 wrote `withdraw` on a column no row has
 * ever carried, because the vault withdraw path does not exist yet.)
 */
export const EARN_MOVEMENT_DIRECTIONS = ["deposit", "withdrawal"] as const;
export type EarnMovementDirection = (typeof EARN_MOVEMENT_DIRECTIONS)[number];

/**
 * Statuses per execution model, because the two lifecycles are genuinely
 * different rather than one lifecycle wearing two vocabularies:
 *
 * * `custodial` — a provider reports settlement, and can report a PARTIAL one
 *   or park a payout awaiting a customer approval stamp. This is 0055's
 *   vocabulary unchanged.
 * * `vault_direct` — a chain reports commitment, which is not settlement.
 *   `confirmed` is an optimistic commitment a fork can still drop; `finalized`
 *   is irreversible. `requested` is 0059's `pending` renamed, so that one word
 *   means one thing on both models: a signed transaction is durably recorded
 *   but is not known to be on the wire.
 *
 * So `completed` and `finalized` are not synonyms — they are different facts,
 * and keeping them keyed by model is what lets one column hold both honestly.
 */
export const EARN_MOVEMENT_STATUSES = {
  custodial: EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES,
  vault_direct: ["requested", "submitted", "confirmed", "finalized", "failed"],
} as const satisfies Record<EarnExecutionModel, readonly string[]>;

export type EarnCustodialMovementStatus = (typeof EARN_MOVEMENT_STATUSES)["custodial"][number];
export type EarnVaultDirectMovementStatus = (typeof EARN_MOVEMENT_STATUSES)["vault_direct"][number];
export type EarnMovementStatus = EarnCustodialMovementStatus | EarnVaultDirectMovementStatus;

/**
 * Statuses a movement never moves on from, per model — the UNIFIED ledger's
 * answer, and the one new code should use.
 *
 * Not to be confused with `EARN_TERMINAL_VAULT_MOVEMENT_STATUSES` above, which
 * is the legacy `earn_vault_movements` vocabulary and calls `confirmed`
 * terminal. See that constant's note for why the disagreement is intentional.
 */
export const EARN_TERMINAL_MOVEMENT_STATUSES = {
  custodial: EARN_TERMINAL_WITHDRAWAL_STATUSES,
  // `confirmed` is deliberately absent, unlike 0059's terminal set: the sweep's
  // job does not end at chain commitment now that finalization is a state.
  vault_direct: ["finalized", "failed"],
} as const satisfies {
  [Model in EarnExecutionModel]: readonly (typeof EARN_MOVEMENT_STATUSES)[Model][number][];
};

/**
 * Legal transitions, keyed by TARGET status to the statuses it may be reached
 * from — the shape both legacy guards already used.
 *
 * Two properties make terminal-state regression unrepresentable rather than
 * merely discouraged: terminal statuses appear in NO source list, and neither
 * model's insert state (`requested`) is a target at all. Repositories apply
 * these as a database-level compare-and-swap (`status IN (...)` in the same
 * statement as the write), so a concurrent writer that already advanced a row
 * makes the loser match zero rows instead of overwriting it.
 *
 * `custodial` self-transitions are intentional: a same-status observation still
 * refreshes amounts, fees and provider_data, and `processing → processing` is
 * the common poll case. `pending_approval ↔ processing` is a legitimate
 * park/unpark cycle.
 *
 * `vault_direct` allows `submitted → finalized` directly, because a sweep whose
 * first observation is already finalized must be able to record the truth
 * rather than invent an intermediate commitment it never saw. It has no
 * self-transitions: there is no in-place observation refresh on a signed
 * movement, only advancement.
 *
 * ── Who enforces this, and when ───────────────────────────────────────────
 * Both halves are enforced NOW, by a single guard. `allowedSourceStatuses` in
 * `earn-movements.repository.ts` derives every compare-and-swap's legal source
 * states from this matrix, for both execution models, so there is no second
 * copy to drift from. Naming a target the matrix does not carry throws; a
 * source it does not allow is refused by the CAS matching zero rows, which is
 * the answer a lost race already gave. The conformance test in
 * `earn-movements.repository.test.ts` pins the matrix against
 * `earn_movement_statuses`.
 *
 * The matrix is written to be consistent with migration 0062's CHECK
 * constraints, not merely with itself — see the `vault_direct` notes below.
 */
export const EARN_MOVEMENT_TRANSITIONS = {
  custodial: {
    processing: ["requested", "processing", "pending_approval"],
    pending_approval: ["requested", "processing", "pending_approval"],
    completed: ["requested", "processing", "pending_approval"],
    partially_completed: ["requested", "processing", "pending_approval"],
    failed: ["requested", "processing", "pending_approval"],
    cancelled: ["requested", "processing", "pending_approval"],
  },
  vault_direct: {
    submitted: ["requested"],
    // From `requested` too, not only `submitted`: a broadcast whose response was
    // lost leaves a movement unsubmitted WITH a signature, and the chain is then
    // the only authority on it. Refusing the transition would strand exactly the
    // rows reconciliation exists for.
    confirmed: ["requested", "submitted"],
    // Reachable from ANY pre-terminal state, for the same reason: the sweep may
    // learn of finalization as its first observation of a movement, and a
    // transaction the chain calls finalized was demonstrably submitted and
    // committed whether or not SDP recorded those moments separately. The writer
    // stamps `confirmed_at` on the way through, so the row is never a settled one
    // with no record of its own commitment.
    finalized: ["requested", "submitted", "confirmed"],
    // NOT from `confirmed`, deliberately. Migration 0062 ties `confirmed_at` and
    // `shares_out` to the commitment states, so failing a confirmed movement
    // could only succeed by erasing observations SDP genuinely made — and it
    // would make "failed before landing" indistinguishable from "landed, then
    // dropped in a fork". The realistic chain path never asks for it: an
    // execution error is reported with the FIRST status for a signature, not
    // after a clean one. The remaining tail, a confirmed transaction dropped by
    // a fork rollback, is an open question rather than something handled here:
    // such a row stops being observable and is left in the reconciliation queue
    // rather than declared failed on a guess.
    failed: ["requested", "submitted"],
  },
} as const satisfies {
  [Model in EarnExecutionModel]: Partial<
    Record<
      (typeof EARN_MOVEMENT_STATUSES)[Model][number],
      readonly (typeof EARN_MOVEMENT_STATUSES)[Model][number][]
    >
  >;
};

/**
 * A queued or operator-redemption withdrawal request's lifecycle, as
 * `earn_vault_withdrawal_requests.status` stores it.
 */
export const EARN_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "creating",
  "pending",
  "fulfillable",
  "expired_cancelable",
  "cancelling",
  "closed_or_unknown",
  "fulfilled",
  "cancelled",
  "failed",
] as const;
export type EarnVaultWithdrawalRequestStatus =
  (typeof EARN_VAULT_WITHDRAWAL_REQUEST_STATUSES)[number];

/** Requests that never change again: paid, cancelled, or never landed. */
export const EARN_TERMINAL_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "fulfilled",
  "cancelled",
  "failed",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

/** Requests the provider closed on chain: paid out or cancelled. */
export const EARN_CLOSED_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "fulfilled",
  "cancelled",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

/** Requests that are not final yet. */
export const EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "creating",
  "pending",
  "fulfillable",
  "expired_cancelable",
  "cancelling",
  "closed_or_unknown",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

/** Landed requests waiting on the provider; the request account still holds the shares. */
export const EARN_LIVE_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "pending",
  "fulfillable",
  "expired_cancelable",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

/** Landed and not final, a cancellation in flight included. */
export const EARN_LANDED_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  ...EARN_LIVE_VAULT_WITHDRAWAL_REQUEST_STATUSES,
  "cancelling",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

/** Not proven on chain yet, or closed without an outcome SDP could identify. */
export const EARN_UNRESOLVED_VAULT_WITHDRAWAL_REQUEST_STATUSES = [
  "creating",
  "closed_or_unknown",
] as const satisfies readonly EarnVaultWithdrawalRequestStatus[];

const TERMINAL_REQUEST_STATUSES = new Set<EarnVaultWithdrawalRequestStatus>(
  EARN_TERMINAL_VAULT_WITHDRAWAL_REQUEST_STATUSES
);
const CLOSED_REQUEST_STATUSES = new Set<EarnVaultWithdrawalRequestStatus>(
  EARN_CLOSED_VAULT_WITHDRAWAL_REQUEST_STATUSES
);
const LIVE_REQUEST_STATUSES = new Set<EarnVaultWithdrawalRequestStatus>(
  EARN_LIVE_VAULT_WITHDRAWAL_REQUEST_STATUSES
);

/** Whether a request status is final. */
export function isTerminalVaultWithdrawalRequestStatus(
  status: EarnVaultWithdrawalRequestStatus
): boolean {
  return TERMINAL_REQUEST_STATUSES.has(status);
}

/** Whether the provider closed the request on chain (paid out or cancelled). */
export function isClosedVaultWithdrawalRequestStatus(
  status: EarnVaultWithdrawalRequestStatus
): boolean {
  return CLOSED_REQUEST_STATUSES.has(status);
}

/** Whether a landed request still waits on the provider with its shares held. */
export function isLiveVaultWithdrawalRequestStatus(
  status: EarnVaultWithdrawalRequestStatus
): boolean {
  return LIVE_REQUEST_STATUSES.has(status);
}

/**
 * Legal request transitions, keyed by TARGET status to the statuses it may be
 * reached from, the shape `EARN_MOVEMENT_TRANSITIONS` uses.
 * `earn-vault-withdrawal-requests.repository.ts` applies them as a
 * compare-and-swap, and terminal statuses appear in no source list, so a final
 * request cannot regress.
 */
export const EARN_VAULT_WITHDRAWAL_REQUEST_TRANSITIONS = {
  creating: [],
  pending: ["creating", "pending", "closed_or_unknown"],
  fulfillable: ["creating", "pending", "fulfillable", "closed_or_unknown"],
  // A synchronous cancel eligibility read may be the first observer after a
  // finalized request transaction. Permit it to close the short `creating`
  // window instead of making recovery wait for the background sweep.
  expired_cancelable: [
    "creating",
    "pending",
    "fulfillable",
    "expired_cancelable",
    "closed_or_unknown",
  ],
  cancelling: ["expired_cancelable", "cancelling"],
  closed_or_unknown: EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES,
  fulfilled: EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES,
  cancelled: EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES,
  failed: EARN_UNRESOLVED_VAULT_WITHDRAWAL_REQUEST_STATUSES,
} as const satisfies Record<
  EarnVaultWithdrawalRequestStatus,
  readonly EarnVaultWithdrawalRequestStatus[]
>;

/**
 * A request or cancel action is one signed transaction, so it shares the
 * vault-direct movement lifecycle: the same statuses and transitions.
 */
export const EARN_VAULT_WITHDRAWAL_ACTION_STATUSES = EARN_MOVEMENT_STATUSES.vault_direct;
export type EarnVaultWithdrawalActionStatus = EarnVaultDirectMovementStatus;

/** Actions whose transaction may still land. */
export const EARN_IN_FLIGHT_VAULT_WITHDRAWAL_ACTION_STATUSES = [
  "requested",
  "submitted",
  "confirmed",
] as const satisfies readonly EarnVaultWithdrawalActionStatus[];

/** Actions whose transaction reached the chain. */
export const EARN_LANDED_VAULT_WITHDRAWAL_ACTION_STATUSES = [
  "submitted",
  "confirmed",
  "finalized",
] as const satisfies readonly EarnVaultWithdrawalActionStatus[];

/** Legal action transitions, the vault-direct movement matrix with its insert state. */
export const EARN_VAULT_WITHDRAWAL_ACTION_TRANSITIONS = {
  requested: [],
  ...EARN_MOVEMENT_TRANSITIONS.vault_direct,
} as const satisfies Record<
  EarnVaultWithdrawalActionStatus,
  readonly EarnVaultWithdrawalActionStatus[]
>;
