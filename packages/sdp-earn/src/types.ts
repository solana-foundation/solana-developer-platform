import type {
  EarnApyType,
  EarnDepositTokenSymbol,
  EarnLiquidityTerm,
  EarnMovementStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  SdpEnvironment,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";

/**
 * Runtime context for catalogue/quote/execute calls. Providers read their own
 * credentials from `env` keyed by `mode`; the route handler resolves `mode`
 * (it depends on AppContext) and passes plain values so the provider stays
 * AppContext-free. Mirrors `RampRuntimeContext` in @sdp/payments.
 */
export interface EarnRuntimeContext {
  env: Record<string, string | undefined>;
  mode: SdpEnvironment;
}

export interface EarnWebhookValidationContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
  headers: Headers;
  rawBody: string;
  requestUrl?: string;
}

/**
 * Static support a provider declares up front (before any live call): which
 * stablecoin mints it can take deposits in and which strategy shapes it
 * fronts. The live catalogue itself is synced into the DB via
 * `listStrategies`, so — unlike ramp rail support — there is no committed
 * dump/distill snapshot for Earn yet.
 */
export interface EarnDeclaredStrategySupport {
  sourceKinds: readonly EarnStrategySourceKind[];
  depositTokens: readonly EarnDepositTokenSymbol[];
}

/** Live catalogue row as reported by the provider, pre-persistence. */
export interface ProviderStrategySnapshot {
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource?: string;
  depositMints: string[];
  shareMint?: string;
  apyType: EarnApyType;
  currentApy?: string;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays?: number;
  riskMetadata?: EarnStrategyRiskMetadata;
}

/** Point-in-time NAV reading for one strategy. */
export interface ProviderNavSnapshot {
  providerReference: string;
  /** Price of one share in deposit-asset base units, as a decimal string. */
  sharePrice: string;
  apy?: string;
  tvl?: string;
  asOf: string;
}

export interface EarnNavInput {
  strategyProviderReference: string;
}

export interface EarnDepositQuoteInput {
  strategyProviderReference: string;
  tokenMint: string;
  /** Stablecoin amount in base units. */
  amount: string;
  /** Required for execution (createDeposit); optional for rate-preview quotes. */
  depositorWalletAddress?: string;
}

export interface EarnDepositQuote {
  provider: EarnProviderId;
  strategyProviderReference: string;
  /** Shares expected for this deposit, in base units of the share mint. */
  expectedShareAmount?: string;
  sharePrice?: string;
  expiresAt?: string;
}

/**
 * Result of initiating a deposit. Two execution shapes exist:
 * - `transactionBase64`: provider returned an unsigned Solana transaction for
 *   SDP to sign with the depositor wallet (DeFi/vault path).
 * - provider-side subscription referenced by `providerReference`, settled
 *   asynchronously via webhook/poll (RWA subscription path).
 */
export interface EarnDepositIntent {
  provider: EarnProviderId;
  providerReference: string;
  transactionBase64?: string;
  status: EarnMovementStatus;
}

export interface EarnWithdrawalQuoteInput {
  strategyProviderReference: string;
  tokenMint: string;
  /** Shares to redeem in base units; either this or `amount` is set. */
  shareAmount?: string;
  /** Stablecoin amount to receive in base units; either this or `shareAmount` is set. */
  amount?: string;
  /** Required for execution (createWithdrawal); optional for rate-preview quotes. */
  destinationWalletAddress?: string;
}

export interface EarnWithdrawalQuote {
  provider: EarnProviderId;
  strategyProviderReference: string;
  expectedAmount?: string;
  sharePrice?: string;
  /** For delayed-liquidity strategies: when the redemption is expected to settle. */
  redemptionAvailableAt?: string;
  expiresAt?: string;
}

export interface EarnWithdrawalIntent {
  provider: EarnProviderId;
  providerReference: string;
  transactionBase64?: string;
  status: EarnMovementStatus;
  redemptionAvailableAt?: string;
}

export interface EarnMovementStatusInput {
  providerReference: string;
}

export interface EarnMovementStatusResult {
  status: EarnMovementStatus;
  transactionSignature?: string;
  shareAmount?: string;
  redemptionAvailableAt?: string;
}

interface BaseEarnSettlementEvent {
  provider: EarnProviderId;
  /** Provider-side reference correlating back to an earn movement row. */
  reference: string;
}

/**
 * Neutral settlement contract parsed from provider webhooks. The API-side
 * webhook processors verify/parse into this, and a single orchestrator applies
 * it to the DB — mirrors `RampSettlementEvent`.
 */
export type EarnSettlementEvent =
  | (BaseEarnSettlementEvent & {
      kind: "movement_settled";
      shareAmount?: string;
      transactionSignature?: string;
    })
  | (BaseEarnSettlementEvent & { kind: "movement_failed"; error?: string })
  | (BaseEarnSettlementEvent & { kind: "redemption_claimable"; availableAt?: string })
  | { provider: EarnProviderId; kind: "ignore"; reason: string };

/**
 * Full vault-infra provider contract. All HTTP lives behind this; the route
 * handler owns DB interaction and passes pre-resolved inputs. Mirrors
 * `RampProvider` in @sdp/payments/ramps.
 */
export interface EarnVaultProvider {
  provider: EarnProviderId;
  declaredSupport: EarnDeclaredStrategySupport;
  /** Live strategy catalogue; synced into `earn_strategies` by the API. */
  listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]>;
  /** Share price / TVL reading; snapshotted into `earn_nav_snapshots` by cron. */
  getNav(ctx: EarnRuntimeContext, input: EarnNavInput): Promise<ProviderNavSnapshot>;
  quoteDeposit(ctx: EarnRuntimeContext, input: EarnDepositQuoteInput): Promise<EarnDepositQuote>;
  createDeposit(ctx: EarnRuntimeContext, input: EarnDepositQuoteInput): Promise<EarnDepositIntent>;
  quoteWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalQuoteInput
  ): Promise<EarnWithdrawalQuote>;
  createWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalQuoteInput
  ): Promise<EarnWithdrawalIntent>;
  /** Reconciliation-cron poll for providers without (reliable) webhooks. */
  getMovementStatus?(
    ctx: EarnRuntimeContext,
    input: EarnMovementStatusInput
  ): Promise<EarnMovementStatusResult>;
}
