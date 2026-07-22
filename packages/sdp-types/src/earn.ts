import type { EarnProviderId } from "./provider-access";
import type { WellKnownTokenSymbol } from "./well-known-tokens";

/**
 * Solana Earn (SDP Markets V1) — shared wire contracts.
 *
 * Earn is a stablecoin deposit facility: organizations browse a catalogue of
 * yield strategies (DeFi protocols or tokenized RWAs, fronted by vault-infra
 * providers), deposit supported stablecoins into them, and track positions
 * and NAV over time.
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

export const EARN_POSITION_STATUSES = ["active", "closed"] as const;
export type EarnPositionStatus = (typeof EARN_POSITION_STATUSES)[number];

export const EARN_MOVEMENT_DIRECTIONS = ["deposit", "withdrawal"] as const;
export type EarnMovementDirection = (typeof EARN_MOVEMENT_DIRECTIONS)[number];

export const EARN_MOVEMENT_STATUSES = [
  "pending",
  "submitted",
  "settled",
  "failed",
  "cancelled",
] as const;
export type EarnMovementStatus = (typeof EARN_MOVEMENT_STATUSES)[number];

/**
 * Yield sources the catalogue knows how to label. Non-exhaustive on purpose:
 * `EarnStrategy.underlyingSource` stays an open string so onboarding a new
 * RWA or protocol is a catalogue change, not a type migration.
 */
export const EARN_KNOWN_UNDERLYING_SOURCES = [
  "kamino",
  "jup-lend",
  "buidl",
  "benji",
  "ousg",
  "usdy",
  "sweep",
  "syrup-usdc",
  "figure-prime",
  "bagey",
  "usde",
  "aaa-clo",
] as const;
export type EarnKnownUnderlyingSource = (typeof EARN_KNOWN_UNDERLYING_SOURCES)[number];

/**
 * Curators (Gauntlet, Steakhouse, Sentora, ...) publish strategy/risk
 * frameworks but are NOT code integrations: `EarnStrategyRiskMetadata.curator`
 * is an open string written during catalogue sync, so onboarding a new curator
 * is a data change — zero code, zero migration. This registry only maps known
 * ids to display labels; unknown ids render as-is.
 */
export const EARN_KNOWN_CURATOR_LABELS: Readonly<Record<string, string>> = {
  gauntlet: "Gauntlet",
  steakhouse: "Steakhouse Financial",
  sentora: "Sentora",
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
  provider: EarnProviderId;
  /** Provider-side identifier for the vault/strategy. */
  providerReference?: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  /** Open registry — see EARN_KNOWN_UNDERLYING_SOURCES. */
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

export interface EarnPosition {
  id: string;
  strategyId: string;
  walletId: string;
  /** Share balance in base units of the share mint. */
  shareAmount: string;
  /** Net stablecoin deposited in base units (deposits minus withdrawals). */
  costBasis?: string;
  status: EarnPositionStatus;
  createdAt: string;
  updatedAt: string;
}

/** A single deposit or withdrawal against a position. */
export interface EarnMovement {
  id: string;
  positionId: string;
  strategyId: string;
  direction: EarnMovementDirection;
  tokenMint: string;
  /** Stablecoin amount in base units. */
  amount: string;
  /** Shares minted/burned in base units, once known. */
  shareAmount?: string;
  status: EarnMovementStatus;
  transactionSignature?: string;
  /** For delayed redemptions: ISO timestamp when funds become claimable. */
  redemptionAvailableAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One point of the NAV time series snapshotted per strategy. */
export interface EarnNavPoint {
  strategyId: string;
  /** Price of one share in deposit-asset base units, as a decimal string. */
  sharePrice: string;
  apy?: string;
  /** Total value locked in deposit-asset display units. */
  tvl?: string;
  asOf: string;
}

/** Rate preview for a deposit or withdrawal, shared by both directions. */
export interface EarnQuoteBreakdown {
  provider: EarnProviderId;
  strategyId: string;
  tokenMint: string;
  /** Stablecoin amount in base units (requested for deposits, expected for withdrawals). */
  amount?: string;
  /** Shares expected/redeemed in base units of the share mint. */
  shareAmount?: string;
  sharePrice?: string;
  /** For delayed-liquidity strategies: when the redemption is expected to settle. */
  redemptionAvailableAt?: string;
  expiresAt?: string;
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

export interface EarnNavHistoryResponse {
  strategyId: string;
  navPoints: EarnNavPoint[];
}

export interface EarnPositionResponse {
  position: EarnPosition;
}

export interface ListEarnPositionsResponse {
  positions: EarnPosition[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EarnMovementResponse {
  movement: EarnMovement;
}

export interface ListEarnMovementsResponse {
  movements: EarnMovement[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EarnQuoteResponse {
  quote: EarnQuoteBreakdown;
}
