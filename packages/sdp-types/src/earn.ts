import type { WellKnownTokenSymbol } from "./well-known-tokens";

/**
 * Solana Earn (SDP Markets V1) — shared wire contracts.
 *
 * Earn is a stablecoin deposit facility: organizations browse a catalogue of
 * yield strategies (DeFi protocols or tokenized RWAs, fronted by vault-infra
 * providers), fund a shared portfolio wallet, and withdraw to addresses they
 * control. Positions and balances are always read live from the provider
 * (never persisted); SDP-initiated withdrawals are recorded in a ledger —
 * "Record"-suffixed types are ledger rows, `EarnPortfolio*` types are live
 * provider reads (PRO-1628 / ADR 0002 addendum).
 *
 * Registries follow ADR 0001 (asset profiles): closed unions defined in code,
 * open TEXT columns in Postgres, Zod validation at the app layer — adding a
 * new kind is a code change, never a migration.
 */

/** Day-one deposit stablecoins for Earn V1 (confirmed: USDC, USDG, USDT). */
export const EARN_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
  "USDG",
  "USDT",
] as const satisfies readonly WellKnownTokenSymbol[];
export type EarnDepositTokenSymbol = (typeof EARN_DEPOSIT_TOKEN_SYMBOLS)[number];

export const EARN_STRATEGY_SOURCE_KINDS = ["defi", "rwa"] as const;
export type EarnStrategySourceKind = (typeof EARN_STRATEGY_SOURCE_KINDS)[number];

export const EARN_APY_TYPES = ["variable", "fixed"] as const;
export type EarnApyType = (typeof EARN_APY_TYPES)[number];

export const EARN_LIQUIDITY_TERMS = ["instant", "delayed"] as const;
export type EarnLiquidityTerm = (typeof EARN_LIQUIDITY_TERMS)[number];

export const EARN_STRATEGY_STATUSES = ["active", "paused", "deprecated"] as const;
export type EarnStrategyStatus = (typeof EARN_STRATEGY_STATUSES)[number];

/**
 * Curators (Gauntlet, Steakhouse, Sentora, ...) publish strategy/risk
 * frameworks but are NOT code integrations: `EarnStrategyRiskMetadata.curator`
 * is an open string written during catalogue sync, so onboarding a new curator
 * is a data change — zero code, zero migration. This registry only maps known
 * ids to display labels; unknown ids render as-is.
 */
/**
 * Display labels ONLY — never a matching vocabulary. Order is irrelevant and
 * adding an entry can never change how any provider derives a curator: that
 * derivation is provider-specific and keeps its own vocabulary (Ground's lives
 * in `@sdp/earn` providers/ground/client.ts). Keeping the two apart is what
 * makes "onboarding a curator is a data change" literally true.
 */
export const EARN_KNOWN_CURATOR_LABELS: Readonly<Record<string, string>> = {
  // Curator houses.
  gauntlet: "Gauntlet",
  steakhouse: "Steakhouse Financial",
  sentora: "Sentora",
  smokehouse: "Smokehouse",
  morpho: "Morpho",
  allez: "Allez Labs",
  rockawayx: "RockawayX",
  august: "August",
  superstate: "Superstate",
  // Ids Ground reports when a protocol or fund curates its own vaults;
  // `g<ticker>` is Ground's own wrapper of a Superstate fund.
  kamino: "Kamino",
  maple: "Maple",
  centrifuge: "Centrifuge",
  aave_v3: "Aave V3",
  gustb: "Superstate USTB",
  guscc: "Superstate USCC",
};

export function earnCuratorLabel(curator: string): string {
  return EARN_KNOWN_CURATOR_LABELS[curator] ?? curator;
}

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

export interface EarnStrategy {
  id: string;
  /**
   * Vault-infra provider id. Open string on the read model: catalogue rows
   * persist as open TEXT and may reference a provider this deployment no
   * longer (or does not yet) register, so dispatch always resolves fail-closed
   * server-side.
   */
  provider: string;
  /** Provider-side identifier for the vault/strategy. */
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
  createdAt: string;
  updatedAt: string;
}

/**
 * Portfolio wallets — provider-neutral wire contracts.
 *
 * Some vault-infra providers front a managed multi-source portfolio (one
 * omnibus wallet whose funds are spread across yield sources by a target
 * strategy) instead of per-strategy vault positions. SDP keeps ONE shared
 * portfolio wallet per (organization, environment); choosing a curator
 * rewrites that wallet's strategy weights. All USD figures are decimal
 * strings; allocation weights are percent on the way in (what strategies are
 * authored in) and basis points on the way out (what providers report back).
 */

/** Deposit tokens a portfolio strategy is keyed by (provider-neutral lowercase). */
export const EARN_PORTFOLIO_TOKENS = ["usdc", "usdt"] as const;
export type EarnPortfolioToken = (typeof EARN_PORTFOLIO_TOKENS)[number];

/** One authored strategy weight: percent of the token's funds, 0–100 in 0.1 steps. */
export interface EarnPortfolioAllocation {
  yieldSourceId: string;
  pct: number;
}

/** Desired strategy per deposit token; tokens omitted keep their current allocation. */
export type EarnPortfolioAllocationInput = Partial<
  Record<EarnPortfolioToken, EarnPortfolioAllocation[]>
>;

/** One provider-confirmed strategy weight, in basis points of the token's funds. */
export interface EarnPortfolioTargetWeight {
  yieldSourceId: string;
  weightBps: number;
}

export type EarnPortfolioTargetAllocations = Partial<
  Record<EarnPortfolioToken, EarnPortfolioTargetWeight[]>
>;

/**
 * Neutral wallet lifecycle. `busy` covers every provider-side workflow state
 * (withdrawal/rebalance in flight) where funds stay visible but strategy
 * mutations should wait; unmapped provider statuses normalize to it.
 */
export const EARN_PORTFOLIO_WALLET_STATUSES = ["creating", "ready", "busy", "failed"] as const;
export type EarnPortfolioWalletStatus = (typeof EARN_PORTFOLIO_WALLET_STATUSES)[number];

/** Wallet balances in USD decimal strings. */
export interface EarnPortfolioBalance {
  totalUsd: string;
  withdrawableUsd: string;
  reservedUsd: string;
  earnedUsd: string;
}

/**
 * Where a slice of the portfolio currently sits. `bridge`/`external_payout`
 * are funds in transit between sources or out to a destination; unmapped
 * provider kinds normalize to `unknown` rather than being dropped, so the
 * position list always sums to the wallet total.
 */
export const EARN_PORTFOLIO_POSITION_KINDS = [
  "yield_source",
  "cash",
  "bridge",
  "external_payout",
  "unknown",
] as const;
export type EarnPortfolioPositionKind = (typeof EARN_PORTFOLIO_POSITION_KINDS)[number];

export interface EarnPortfolioPosition {
  kind: EarnPortfolioPositionKind;
  label: string;
  /** USD decimal string. */
  valueUsd: string;
  /** Share of the wallet total, 0–100. */
  pct?: number;
  /** Set for `yield_source` positions; joins back to the strategy catalogue. */
  yieldSourceId?: string;
  token?: EarnPortfolioToken;
}

/**
 * What a `busy` wallet is actually doing, in provider-neutral terms.
 *
 * `status` alone answers "can it take a mutation"; this answers "what is
 * happening to my money", which is the question a reader waiting on a screen
 * is asking. Every provider client derives it from its OWN status vocabulary,
 * so no consumer ever parses a provider's raw strings — the same reason
 * position labels arrive display-ready.
 *
 * Optional by design: absent whenever the wallet is not busy, and absent for a
 * busy state the provider client does not recognize (which still reports
 * `busy`, never a guessed activity).
 */
export const EARN_PORTFOLIO_WALLET_ACTIVITIES = ["withdrawing", "rebalancing"] as const;
export type EarnPortfolioWalletActivity = (typeof EARN_PORTFOLIO_WALLET_ACTIVITIES)[number];

/** Live provider read of the shared wallet; never persisted, always fetched. */
export interface EarnPortfolioWalletSnapshot {
  providerWalletRef: string;
  status: EarnPortfolioWalletStatus;
  /** Named operation behind `busy`; see {@link EarnPortfolioWalletActivity}. */
  activity?: EarnPortfolioWalletActivity;
  /** Raw provider status string, for diagnostics/detail display. */
  providerStatus?: string;
  /**
   * Funding address on the Solana rail for this environment. The only rail
   * SDP surfaces; absent while the wallet is still `creating`.
   */
  solanaDepositAddress?: string;
  balance: EarnPortfolioBalance;
  positions: EarnPortfolioPosition[];
  allocations: EarnPortfolioTargetAllocations;
}

export const EARN_PORTFOLIO_DEPOSIT_STATUSES = ["processing", "completed", "failed"] as const;
export type EarnPortfolioDepositStatus = (typeof EARN_PORTFOLIO_DEPOSIT_STATUSES)[number];

/** One on-chain deposit detected against the wallet's funding address. */
export interface EarnPortfolioDeposit {
  id: string;
  /** USD decimal string. */
  amountUsd: string;
  token: EarnPortfolioToken;
  status: EarnPortfolioDepositStatus;
  fromAddress?: string;
  transactionSignature?: string;
  createdAt: string;
  completedAt?: string;
}

export interface EarnPortfolioDepositsPage {
  deposits: EarnPortfolioDeposit[];
  nextCursor: string | null;
}

/**
 * `pending_approval` is synthesized by the provider client, never reported
 * top-level by the provider: Ground parks the affected payout leg in
 * `pending_customer_approval` (awaiting a customer-side Turnkey stamp) while
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
export type EarnPortfolioWithdrawalStatus = (typeof EARN_PORTFOLIO_WITHDRAWAL_STATUSES)[number];

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
] as const satisfies readonly EarnPortfolioWithdrawalStatus[];

/**
 * Ledger-row status vocabulary: `requested` is SDP-only pre-provider intent
 * state (the row exists, the provider call has not been accepted yet); every
 * other value is the canonical provider-observed status.
 */
export const EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES = [
  "requested",
  ...EARN_PORTFOLIO_WITHDRAWAL_STATUSES,
] as const;
export type EarnProgramWithdrawalRecordStatus =
  (typeof EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES)[number];

/** A portfolio-level withdrawal to a Solana destination address — the LIVE provider read. */
export interface EarnPortfolioWithdrawal {
  withdrawalRef: string;
  status: EarnPortfolioWithdrawalStatus;
  /** USD decimal strings. */
  amountRequestedUsd?: string;
  amountPaidUsd?: string;
  feeUsd?: string;
  token?: EarnPortfolioToken;
  destinationAddress: string;
  failureReason?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * One row of the SDP withdrawal ledger — the durable record of what SDP
 * initiated ("Record" always means ledger; `EarnPortfolioWithdrawal` is the
 * live provider read). Written at intent and on every observation; the
 * provider stays authoritative for live status and final amounts.
 */
export interface EarnProgramWithdrawalRecord {
  id: string;
  /** Open string on the read model — a row can outlive its provider's registry entry. */
  provider: string;
  status: EarnProgramWithdrawalRecordStatus;
  /** USD decimal strings. */
  amountRequestedUsd: string;
  amountPaidUsd?: string;
  feeUsd?: string;
  token: EarnPortfolioToken;
  destinationAddress: string;
  failureReason?: string;
  /** Provider-side withdrawal reference; absent while the row is still `requested`. */
  withdrawalRef?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Provider settlement-time estimate, ISO-8601 durations. */
export interface EarnPortfolioProcessingEstimate {
  basis: "elapsed_seconds" | "banking_days";
  typicalMinDuration: string;
  typicalMaxDuration: string;
}

/** Per-yield-source yield metrics behind a program's blended rate. */
export interface EarnPortfolioYieldPosition {
  yieldSourceId: string;
  name: string;
  /** Decimal rate (`0.0453` = 4.53%), converted from the provider's basis points. */
  apy: string;
  /** Target allocation percentage (0-100). */
  pct: number;
  deployedValueUsd: string;
}

/**
 * Yield metrics for a program. Providers report per-position rates rather than
 * one wallet rate, so `currentApy` is **derived**: a weighted blend of the
 * position rates, weighted by deployed value when anything is deployed and by
 * target allocation otherwise (a funded-but-unrebalanced program still has a
 * meaningful forward rate). Absent when no position carries a rate — e.g. a
 * program held entirely as cash.
 */
export interface EarnPortfolioYield {
  currentApy?: string;
  /** Cumulative yield since the program was created. */
  earnedUsd: string;
  /** Estimated annualized yield in USD at current rates. */
  annualizedUsd?: string;
  positions: EarnPortfolioYieldPosition[];
}

export interface EarnPortfolioWithdrawalPreview {
  /** USD decimal strings. */
  amountRequestedUsd?: string;
  feeUsd: string;
  withdrawableUsd: string;
  totalUsdAfterWithdrawal: string;
  processingEstimate?: EarnPortfolioProcessingEstimate;
}

// API response envelopes (mirrors the asset-profiles response naming).
export interface EarnStrategyResponse {
  strategy: EarnStrategy;
}

export interface ListEarnStrategiesResponse {
  strategies: EarnStrategy[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListEarnProgramWithdrawalsResponse {
  withdrawals: EarnProgramWithdrawalRecord[];
  total: number;
  page: number;
  pageSize: number;
}
