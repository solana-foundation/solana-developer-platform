import type { SolanaCluster, WellKnownTokenSymbol } from "./well-known-tokens";

/**
 * Solana Earn (SDP Markets V1) — shared wire contracts.
 *
 * Earn is a stablecoin deposit facility: organizations browse a catalogue of
 * yield strategies (DeFi protocols or tokenized RWAs, fronted by vault-infra
 * providers), fund a shared portfolio wallet, and withdraw to addresses they
 * control. Custodial portfolio balances are read live from the provider, while
 * non-custodial vault ownership and movement records are durable and their
 * balances are hydrated live. SDP-initiated portfolio withdrawals are recorded
 * in a ledger — "Record"-suffixed types are ledger rows, `EarnPortfolio*`
 * types are live provider reads (PRO-1628 / ADR 0002 addendum).
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
  // Curator houses. A house is chain-agnostic because Ground can route Solana
  // USDC into sources it hosts elsewhere.
  gauntlet: "Gauntlet",
  steakhouse: "Steakhouse Financial",
  sentora: "Sentora",
  smokehouse: "Smokehouse",
  morpho: "Morpho",
  allez: "Allez Labs",
  rockawayx: "RockawayX",
  august: "August",
  superstate: "Superstate",
  maple: "Maple",
  centrifuge: "Centrifuge",
  // Ids Ground reports when a protocol or fund curates its own vaults;
  // `g<ticker>` is Ground's own wrapper of a Superstate fund. Some stored rows
  // (Aave/Morpho) are hidden by strategy API policy, but inventory tooling still
  // renders their metadata.
  kamino: "Kamino",
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
  /**
   * The cluster the strategy's INSTRUMENT actually lives on — not the cluster
   * of the environment that catalogued it, and the two can differ.
   *
   * A provider may front instruments that do not exist on every cluster, so a
   * row can name a live mainnet vault while sitting in a sandbox catalogue:
   * everything about it true, none of it fundable from devnet. Kamino was the
   * original example and no longer is — it has a devnet deployment, so each
   * environment now catalogues its own cluster, and the sync refuses to store a
   * mainnet instrument outside production. The column stays because the
   * mismatch is structural, not Kamino-shaped: rows written before that guard
   * survive until a delist pass, and the next single-cluster provider brings it
   * straight back.
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
   * question; a deposit additionally needs the provider to expose SDP a
   * money-movement surface (a catalogue-only provider like Kamino answers 501
   * on `POST /v1/earn/programs`) and your organization to be entitled to that
   * provider. Those are deliberately not folded in here: this field describes
   * the INSTRUMENT, and entitlement in particular is a property of the caller,
   * not of a platform-global catalogue row.
   */
  fundable: boolean;
  createdAt: string;
  updatedAt: string;
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
  /** Absent when the provider read failed; never coerce an unavailable value to zero. */
  shares?: string;
  /** Deposit-token value, absent when the provider cannot hydrate the position. */
  tokenValue?: string;
}

export interface EarnVaultPositionsPage {
  positions: EarnVaultPosition[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** JSON body for POST /v1/earn/vault-deposits. Idempotency is header-only. */
export interface EarnVaultDepositRequest {
  strategyId: string;
  custodyWalletId: string;
  amount: string;
  minSharesOut?: string;
}

export const EARN_VAULT_MOVEMENT_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
] as const;
export type EarnVaultMovementStatus = (typeof EARN_VAULT_MOVEMENT_STATUSES)[number];

/**
 * Statuses a vault movement never moves on from — in migration 0059's LEGACY
 * vocabulary, which is what `earn_vault_movements` and every existing wire
 * contract still speak.
 *
 * **Do not reach for this in new code.** The unified ledger's answer is
 * `EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct`, and the two deliberately
 * disagree: `confirmed` is terminal HERE because 0059 had no state after chain
 * commitment, and is NOT terminal there because `finalized` now exists and a
 * confirmed transaction can still be dropped by a fork. Treating `confirmed` as
 * settled is exactly the conflation the unification exists to end, so this set
 * is correct only for a consumer reading the legacy table or a legacy wire
 * field. Both names are retired together when the legacy tables are dropped.
 */
export const EARN_TERMINAL_VAULT_MOVEMENT_STATUSES = ["confirmed", "failed"] as const;
export type EarnTerminalVaultMovementStatus =
  (typeof EARN_TERMINAL_VAULT_MOVEMENT_STATUSES)[number];

/** Durable result of a submitted vault deposit (fresh or idempotently replayed). */
export interface EarnVaultDeposit {
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
  /** Set only once the sweep observed the transaction on chain. */
  confirmedAt: string | null;
}

/** Response body of GET /v1/earn/vault-deposits/:movementId. */
export interface EarnVaultDepositResponse {
  deposit: EarnVaultDepositRecord;
}

/**
 * Response body of GET /v1/earn/vault-deposits — one workspace's recorded
 * deposits, newest first.
 *
 * A bounded window, not a complete history: it exists so a client can re-derive
 * which of its deposits are still in flight after losing local state, and the
 * reconciliation sweep settles a movement within about ninety seconds, so
 * anything unsettled is by construction recent. Follow `nextCursor` for more.
 */
export interface EarnVaultDepositsPage {
  deposits: EarnVaultDepositRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Portfolio wallets — provider-neutral wire contracts.
 *
 * Some vault-infra providers front a managed multi-source portfolio (one
 * omnibus wallet whose funds are spread across yield sources by a target
 * strategy) instead of per-strategy vault positions. Each such wallet is one
 * SDP "program"; an organization may hold several per environment (PRO-1670),
 * each pinned to a single vault, with nothing rebalancing across them.
 * Selecting a strategy re-targets one program's weights. All USD figures are
 * decimal strings; allocation weights are percent on the way in (what
 * strategies are authored in) and basis points on the way out (what providers
 * report back).
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
  /**
   * USD decimal strings. Absent when the preview was asked WITHOUT an amount —
   * the liquidity-read form, which answers `withdrawableUsd` for the lane and
   * validates no particular request (PRO-1675).
   */
  amountRequestedUsd?: string;
  feeUsd: string;
  withdrawableUsd: string;
  totalUsdAfterWithdrawal: string;
  processingEstimate?: EarnPortfolioProcessingEstimate;
}

/**
 * A destination lane's balance breakdown, as reported alongside a provider's
 * refusal to pay out more than it holds. Carried on `error.details.balance` of
 * a 409 so the caller can say how short the request was instead of echoing
 * provider wire text; every field is optional because it reflects whatever the
 * provider actually sent. USD decimal strings, like every other Earn amount.
 */
export interface EarnPortfolioLiquidityBalance {
  totalUsd?: string;
  withdrawableUsd?: string;
  reservedUsd?: string;
}

// API response envelopes (mirrors the asset-profiles response naming).

/**
 * One provider-managed Earn program, hydrated from the provider on every read.
 * The program id, label, and creation time are SDP-owned; wallet and yield state
 * remain provider-authoritative and are never replaced with persisted balances.
 */
export interface EarnProgram {
  /** SDP's own program id — how every `/programs/:programId` route names it. */
  id: string;
  /** Open provider id because a persisted program can outlive its registry entry. */
  provider: string;
  label: string | null;
  createdAt: string;
  wallet: EarnPortfolioWalletSnapshot;
  /**
   * Absent when the provider's yield lookup fails. Balances remain available,
   * while consumers render an unavailable rate rather than fabricating 0%.
   */
  yield?: EarnPortfolioYield;
}

export interface EarnProgramResponse {
  program: EarnProgram;
}

export interface ListEarnProgramsResponse {
  programs: EarnProgram[];
  total: number;
  page: number;
  pageSize: number;
}

export type EarnProgramDepositsResponse = EarnPortfolioDepositsPage;

export interface EarnProgramWithdrawalPreviewResponse {
  preview: EarnPortfolioWithdrawalPreview;
}

export interface EarnProgramWithdrawalResponse {
  withdrawal: EarnPortfolioWithdrawal;
}

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

export function isTerminalEarnMovementStatus(
  executionModel: EarnExecutionModel,
  status: string
): boolean {
  return (EARN_TERMINAL_MOVEMENT_STATUSES[executionModel] as readonly string[]).includes(status);
}

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
 * The custodial half is enforced NOW: `earn-withdrawal-ledger.service.ts`
 * derives its compare-and-swap source statuses from it, so there is no second
 * copy to drift from. The vault half has no enforcer in this release — the
 * live guard (`assertValidMovementTransition` in `earn-vault.repository.ts`)
 * still speaks migration 0059's legacy vocabulary (`pending`, and `confirmed`
 * as terminal) because it guards the LEGACY table, which is still the
 * authoritative writer here. It is replaced by a guard reading this matrix in
 * the release that switches reads to the unified ledger; until then the
 * vault half describes the ledger's intended lifecycle, and the conformance
 * test in `earn-movements.repository.test.ts` pins it against
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
 * One row of the unified Earn ledger — the cross-provider movement record.
 *
 * This is the read PRO-1669 asked for and neither legacy shape could serve: one
 * chronological history of every money movement an organization made through
 * Earn, whichever provider executed it and whichever way. `EarnVaultDepositRecord`
 * and `EarnProgramWithdrawalRecord` remain the per-family views, and both are
 * projections of this same row.
 *
 * Unlike those two, this speaks the ledger's own vocabulary — `requested` and
 * `finalized` included — because it is a new contract with no client to keep
 * compatible. A consumer reads `executionModel` to know which optional fields to
 * expect.
 *
 * Every amount is denominated in `denomination`: `usd` for a custodial movement,
 * the token MINT for a vault one. Never sum across rows without grouping by it.
 * Share quantities appear only in the share-named fields and are not comparable
 * to the amounts.
 */
export interface EarnMovementRecord {
  id: string;
  /** Open string — a row can outlive its provider's registry entry. */
  provider: string;
  executionModel: EarnExecutionModel;
  direction: EarnMovementDirection;
  status: EarnMovementStatus;
  /** The holding this movement belongs to; every movement has exactly one. */
  positionId: string;
  /** `usd`, or the token mint. The unit of every amount below. */
  denomination: string;
  amountRequested: string;
  /** What actually moved, once the provider or the chain has said so. */
  amountSettled?: string;
  feeAmount?: string;
  /** Share units (vault movements only). */
  minSharesOut?: string;
  sharesOut?: string;
  /** Payout stablecoin symbol for a custodial withdrawal; not the unit. */
  payoutToken?: string;
  /** The vault's on-chain address (vault movements only). */
  vaultAddress?: string;
  /** Where the money came from and went, when SDP observed either. */
  sourceAddress?: string;
  destinationAddress?: string;
  /** The provider's own id for THIS movement, when it has one. */
  providerReference?: string;
  /** Solana transaction signature (vault movements only). */
  signature?: string;
  failureReason?: string;
  /** Who moved it: a dashboard user, an API key, or neither for a system write. */
  createdBy?: string;
  initiatedByKeyId?: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic chain commitment; not settlement. */
  confirmedAt?: string;
  /** Success-terminal: finalization, or provider completion. */
  settledAt?: string;
}

/** Response body of GET /v1/earn/movements — newest first, keyset-paged. */
export interface EarnMovementsPage {
  movements: EarnMovementRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}
