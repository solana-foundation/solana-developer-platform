import type {
  EarnApyType,
  EarnDepositTokenSymbol,
  EarnLiquidityTerm,
  EarnPortfolioAllocationInput,
  EarnPortfolioDepositsPage,
  EarnPortfolioTargetAllocations,
  EarnPortfolioToken,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWalletStatus,
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalPreview,
  EarnPortfolioYield,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  SdpEnvironment,
  SolanaCluster,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";

/**
 * Runtime context for catalogue/quote/execute calls. Providers read their own
 * credentials from `env` keyed by `environment`; the route handler resolves
 * `environment` (it depends on AppContext) and passes plain values so the
 * provider stays AppContext-free. Same shape as `RampRuntimeContext` in
 * @sdp/payments, but named `environment` to match the rest of Earn.
 */
export interface EarnRuntimeContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
}

/**
 * Static support a provider declares up front (before any live call): which
 * stablecoin symbols it can take deposits in and which strategy shapes it
 * fronts. Consumed by catalogue-sync validation — a snapshot reported by
 * `listStrategies` that falls outside this envelope is provider drift, not a
 * strategy to persist (see `isStrategyWithinDeclaredSupport`). Declared in
 * symbols, not mints, because the declaration is cluster-agnostic; the
 * helper bridges to the mint addresses the runtime speaks. Unlike ramp rail
 * support there is no committed dump/distill snapshot for Earn yet.
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
  /**
   * The cluster this strategy's instrument lives on. REQUIRED — every provider
   * must state it rather than let the sync assume the environment's own
   * cluster, because that assumption is exactly what a mainnet-only provider
   * catalogued into sandbox would violate silently (see `EarnStrategy` in
   * @sdp/types). Ground answers with its environment's cluster; Kamino always
   * answers `mainnet-beta`.
   */
  hostCluster: SolanaCluster;
}

/**
 * Base vault-infra provider contract: the catalogue, and nothing speculative.
 * Every member is real and called (V1 is portfolio-only — per-strategy
 * quote/execution seams live in git history until PRO-1634 gives them a
 * consumer). All HTTP lives behind this; the route handler owns DB interaction
 * and passes pre-resolved inputs. Optional surfaces are capability extensions
 * (see EarnPortfolioWalletProvider / EarnWithdrawalApprovalProvider) detected
 * by method presence in capabilities.ts — never provider-id checks.
 */
export interface EarnVaultProvider {
  provider: EarnProviderId;
  declaredSupport: EarnDeclaredStrategySupport;
  /** Live strategy catalogue; synced into `earn_strategies` by the API. */
  listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]>;
}

/**
 * The volatile half of a catalogue row: the numbers that move on their own
 * between syncs. Deliberately NOT a whole snapshot — a refresh may only update
 * figures, never a strategy's identity, mints, or liquidity terms, so nothing
 * on this shape can admit a vault the catalogue gate would refuse.
 */
export interface ProviderStrategyMetrics {
  /** Must match a `providerReference` the catalogue already holds. */
  providerReference: string;
  /** Latest APY as a decimal string; omitted when the provider has no rate. */
  currentApy?: string;
  /**
   * Volatile risk-metadata figures (TVL, holders, utilization). MERGED over the
   * stored metadata rather than replacing it, so slow-moving fields the
   * catalogue sync owns — curator above all — survive a refresh that does not
   * report them.
   */
  riskMetadata?: EarnStrategyRiskMetadata;
}

/**
 * Optional capability: rates fresh enough to quote.
 *
 * The catalogue sync runs hourly because catalogue DRIFT is slow — a provider
 * onboarding or delisting a vault. Rates are not slow, and an hour-old APY on a
 * comparison table is a number a customer could act on wrongly. A provider that
 * can serve its whole shelf's live figures in a call or two implements this,
 * and a short-cadence pass refreshes only those figures in place.
 *
 * Why a write pass and not a live read at request time: the strategies route
 * reads exactly ONE source for the state it reports (ADR 0002 addendum), and
 * overlaying live numbers onto DB rows at read time would blend two. Freshness
 * comes from cadence instead, so the route stays a plain DB read and every
 * consumer — API, dashboard, a partner's own cache — sees the same figures.
 *
 * Discovered via `supportsLiveMetrics` (capabilities.ts), never provider-id
 * checks. A provider that would need one request per vault should NOT implement
 * this; the pass would cost more than the staleness it removes.
 */
export interface EarnLiveMetricsProvider extends EarnVaultProvider {
  /**
   * Current figures for every strategy this provider lists. Returning a
   * reference the catalogue does not hold is harmless — the refresh updates
   * existing rows and never inserts.
   */
  listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]>;
}

export interface EarnPortfolioWalletCreateInput {
  label: string;
  allocations: EarnPortfolioAllocationInput;
  /**
   * Idempotency key (UUIDv4), REQUIRED since PRO-1670 — the same reason the
   * withdrawal input requires one. Until then an organization held at most one
   * program per (environment, provider) and a DB unique constraint caught a
   * retried create; with N programs legal, nothing downstream can tell a retry
   * from a genuine second program, so the key is the ONLY defence against
   * provisioning a duplicate wallet the customer may then fund.
   */
  requestId: string;
}

export interface EarnPortfolioWalletCreateResult {
  providerWalletRef: string;
  status: EarnPortfolioWalletStatus;
}

export interface EarnPortfolioWalletRefInput {
  providerWalletRef: string;
}

export interface EarnPortfolioStrategyUpdateInput {
  providerWalletRef: string;
  allocations: EarnPortfolioAllocationInput;
  /** Idempotency key (UUIDv4) forwarded to the provider; generated when omitted. */
  requestId?: string;
}

export interface EarnPortfolioStrategyUpdateResult {
  /** Provider-confirmed weights the wallet will rebalance toward. */
  allocations: EarnPortfolioTargetAllocations;
}

export interface EarnPortfolioDepositsInput {
  providerWalletRef: string;
  cursor?: string;
}

export interface EarnPortfolioWithdrawalPreviewInput {
  providerWalletRef: string;
  /**
   * USD amount as a decimal string. OPTIONAL: omit it to ask the provider what
   * the lane can pay right now, which is the preview's liquidity-read form
   * (PRO-1675). With an amount the preview also validates feasibility; without
   * one it answers `withdrawableUsd` alone and leaves `amountRequestedUsd`
   * unset. A provider must OMIT the field from its wire call when absent —
   * never substitute `0`, which asks a different question.
   */
  amountUsd?: string;
  token: EarnPortfolioToken;
}

export interface EarnPortfolioWithdrawalCreateInput {
  providerWalletRef: string;
  /**
   * Idempotency key (UUIDv4), REQUIRED here unlike the create/update inputs:
   * a withdrawal retry without a stable key can double-send funds, so the
   * caller (which owns the retry loop) must own the key.
   */
  requestId: string;
  /** USD amount as a decimal string. */
  amountUsd: string;
  token: EarnPortfolioToken;
  /** Solana address for this environment's cluster — the only rail SDP surfaces. */
  destinationAddress: string;
}

export interface EarnPortfolioWithdrawalStatusInput {
  providerWalletRef: string;
  withdrawalRef: string;
}

export interface EarnPortfolioAddressBookEntryInput {
  /** Solana address to whitelist as a withdrawal destination. */
  address: string;
  label: string;
}

export interface EarnPortfolioAddressBookEntryResult {
  entryRef: string;
}

export type EarnWithdrawalApprovalAction = "approve" | "reject";

/**
 * One provider-side signing activity parked on customer approval, joined with
 * whatever withdrawal context the provider reports. `providerStatus` and
 * `kind` are provider vocabulary passed through open. The destination fields
 * are provider plumbing that may name non-Solana rails — they exist for
 * operator correlation and must be re-synthesized before ever reaching wire
 * types or UI (ADR 0002 invariant 5).
 */
export interface EarnPendingWithdrawalApproval {
  approvalRef: string;
  providerStatus: string;
  kind?: string;
  withdrawalRef?: string;
  withdrawalLegRef?: string;
  providerWalletRef?: string;
  destinationChain?: string;
  destinationToken?: string;
  destinationAddress?: string;
  amountNativeUnits?: string;
  firstSeenAt?: string;
}

export interface EarnWithdrawalApprovalRequestInput {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
}

/**
 * The payload the customer's signer must stamp. `signingPayload` is the exact
 * string to sign, byte-for-byte — re-serializing `providerRequest` can reorder
 * keys and invalidate the signature. `providerRequest` is echoed unmodified
 * into the vote submission so the provider can verify what was signed.
 */
export interface EarnWithdrawalApprovalRequest {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
  signingPayload: string;
  providerRequest: Record<string, unknown>;
}

/**
 * Signature produced by the customer's signer, outside SDP and outside the
 * provider. Either an opaque string or a header pair, matching the shapes
 * signer SDKs emit.
 */
export type EarnWithdrawalApprovalStamp = string | { headerName: string; headerValue: string };

export interface EarnWithdrawalApprovalVoteInput {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
  stamp: EarnWithdrawalApprovalStamp;
  /** The untouched `providerRequest` from `createWithdrawalApprovalRequest`. */
  providerRequest: Record<string, unknown>;
}

export interface EarnWithdrawalApprovalVoteResult {
  action: EarnWithdrawalApprovalAction;
  /** The provider recorded this vote. */
  applied: boolean;
  /** The activity had already reached a terminal state before this vote. */
  alreadyResolved: boolean;
  providerStatus?: string;
}

/**
 * Optional capability: managed portfolio wallets (one omnibus wallet whose
 * funds spread across yield sources by a target strategy). Declared the same
 * way ramp providers declare optional operations — a provider opts in by
 * implementing the methods, and callers discover it via
 * `supportsPortfolioWallets` (see capabilities.ts) instead of dispatching on
 * provider ids, so the next portfolio provider is a client change only.
 * Chain rails are implicit: SDP is Solana-only, so deposit addresses and
 * withdrawal destinations always ride the environment's Solana cluster.
 */
export interface EarnPortfolioWalletProvider extends EarnVaultProvider {
  createPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletCreateInput
  ): Promise<EarnPortfolioWalletCreateResult>;
  getPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioWalletSnapshot>;
  updatePortfolioStrategy(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioStrategyUpdateInput
  ): Promise<EarnPortfolioStrategyUpdateResult>;
  /**
   * Yield metrics for the program (earned to date + the blended current rate).
   * Separate from `getPortfolioWallet` because providers serve it from a
   * distinct endpoint; callers that only need balances must not pay for it.
   */
  getPortfolioYield(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioYield>;
  listPortfolioDeposits(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioDepositsInput
  ): Promise<EarnPortfolioDepositsPage>;
  previewPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalPreviewInput
  ): Promise<EarnPortfolioWithdrawalPreview>;
  createPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalCreateInput
  ): Promise<EarnPortfolioWithdrawal>;
  getPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalStatusInput
  ): Promise<EarnPortfolioWithdrawal>;
  /**
   * Whitelist a withdrawal destination in the provider's address book.
   * Providers may enforce (or later enable) destination whitelisting; exposing
   * it on the contract lets the API pre-register destinations instead of
   * folding an implicit write into the withdrawal flow.
   */
  createPortfolioAddressBookEntry(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioAddressBookEntryInput
  ): Promise<EarnPortfolioAddressBookEntryResult>;
}

/**
 * Optional capability: customer-approval flows for withdrawal payouts. Some
 * providers gate payout legs on a customer-side signature (Ground: Turnkey
 * consensus voting, engaged by an org-level approval policy rather than by
 * default). SDP relays the provider's signing payload and the customer's
 * stamp; the signing key itself never enters SDP — if no signer is available,
 * this capability surfaces the parked state but cannot advance it. Discovered
 * via `supportsWithdrawalApprovals` (capabilities.ts), never provider-id
 * checks.
 */
export interface EarnWithdrawalApprovalProvider extends EarnVaultProvider {
  listPendingWithdrawalApprovals(ctx: EarnRuntimeContext): Promise<EarnPendingWithdrawalApproval[]>;
  createWithdrawalApprovalRequest(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalRequestInput
  ): Promise<EarnWithdrawalApprovalRequest>;
  submitWithdrawalApprovalVote(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalVoteInput
  ): Promise<EarnWithdrawalApprovalVoteResult>;
}
