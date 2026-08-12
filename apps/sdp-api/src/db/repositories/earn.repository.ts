import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnPortfolioToken,
  EarnProgramWithdrawalRecordStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";

export function generateEarnStrategyId(): string {
  return `earn_strategy_${crypto.randomUUID()}`;
}

export function generateEarnProviderWalletId(): string {
  return `earn_provider_wallet_${crypto.randomUUID()}`;
}

export function generateEarnProgramWithdrawalId(): string {
  return `earn_program_withdrawal_${crypto.randomUUID()}`;
}

export interface EarnStrategyRow {
  id: string;
  /**
   * Open TEXT column (ADR 0002): a row can outlive its provider's registry
   * entry, so reads never narrow to EarnProviderId — all dispatch goes through
   * the fail-closed resolveEarnProviderClient. Writes stay closed (see
   * UpsertEarnStrategyInput).
   */
  provider: string;
  provider_reference: string;
  name: string;
  source_kind: EarnStrategySourceKind;
  underlying_source: string | null;
  deposit_mints: string[];
  share_mint: string | null;
  apy_type: EarnApyType;
  current_apy: string | null;
  liquidity_term: EarnLiquidityTerm;
  redemption_delay_days: number | null;
  risk_metadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  environment: SdpEnvironment;
  created_at: string;
  updated_at: string;
}

/**
 * Link to the ONE provider-managed wallet an organization shares per
 * environment (UNIQUE (organization_id, environment, provider) in
 * 0049_earn_provider_wallets.sql). project_id records the provisioning
 * project only — it is not part of the wallet's scope.
 */
export interface EarnProviderWalletRow {
  id: string;
  organization_id: string;
  project_id: string;
  environment: SdpEnvironment;
  /** Open TEXT, same drift rule as EarnStrategyRow.provider. */
  provider: string;
  /** Provider-side wallet identifier (e.g. Ground wallet UUID). */
  provider_wallet_ref: string;
  label: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * One row of the withdrawal ledger (migration 0055): the durable record of the
 * one money movement SDP initiates. Written at intent (status 'requested') and
 * advanced by guarded CAS on every provider observation — see
 * services/earn-withdrawal-ledger.service.ts for the transition matrix.
 */
export interface EarnProgramWithdrawalRow {
  id: string;
  organization_id: string;
  project_id: string;
  wallet_id: string;
  /** Open TEXT, same drift rule as EarnStrategyRow.provider. */
  provider: string;
  status: EarnProgramWithdrawalRecordStatus;
  amount_requested_usd: string;
  amount_paid_usd: string | null;
  fee_usd: string | null;
  token: EarnPortfolioToken;
  destination_address: string;
  failure_reason: string | null;
  /** Derived provider request id — the idempotency anchor (wallet-scoped unique). */
  request_id: string;
  idempotency_fingerprint: string;
  /** Provider withdrawalRef; null while the row is an unresolved intent. */
  provider_reference: string | null;
  provider_data: Record<string, unknown>;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Catalogue sync upsert, keyed on (provider, provider_reference, environment). */
export interface UpsertEarnStrategyInput {
  provider: EarnProviderId;
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource: string | null;
  depositMints: string[];
  shareMint: string | null;
  apyType: EarnApyType;
  currentApy: string | null;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays: number | null;
  riskMetadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  environment: SdpEnvironment;
}

export interface ListEarnStrategiesInput {
  environment: SdpEnvironment;
  sourceKind?: EarnStrategySourceKind;
  apyType?: EarnApyType;
  liquidityTerm?: EarnLiquidityTerm;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export interface ListEarnStrategiesResult {
  rows: EarnStrategyRow[];
  total: number;
}

export interface InsertEarnProviderWalletInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: EarnProviderId;
  providerWalletRef: string;
  label: string | null;
  createdBy: string;
}

/** Insert-at-intent: the row exists before the provider call is accepted. */
export interface CreateEarnProgramWithdrawalInput {
  organizationId: string;
  projectId: string;
  walletId: string;
  provider: EarnProviderId;
  amountRequestedUsd: string;
  token: EarnPortfolioToken;
  destinationAddress: string;
  requestId: string;
  idempotencyFingerprint: string;
  providerData: Record<string, unknown>;
  createdBy: string | null;
  initiatedByKeyId: string | null;
}

/**
 * Guarded compare-and-swap: transitions the row only when its current status
 * is one of `fromStatuses` (pure SQL guard, `status = ANY(...)`), scoped to the
 * organization. Selector is either the row id (create path — the only way a
 * row acquires `providerReference`) or (provider, providerReference) for
 * observation paths. `undefined` fields are untouched; `null` is written;
 * `providerData` is a shallow JSONB merge. Returns null when nothing matched —
 * missing row, wrong org, or the status moved concurrently; callers must not
 * try to tell those apart (payments precedent).
 */
export type UpdateEarnProgramWithdrawalSelector =
  | { withdrawalId: string }
  | { provider: string; providerReference: string };

export interface UpdateEarnProgramWithdrawalStatusGuardedInput {
  selector: UpdateEarnProgramWithdrawalSelector;
  organizationId: string;
  fromStatuses: readonly EarnProgramWithdrawalRecordStatus[];
  toStatus: EarnProgramWithdrawalRecordStatus;
  providerReference?: string;
  amountPaidUsd?: string | null;
  feeUsd?: string | null;
  failureReason?: string | null;
  completedAt?: string | null;
  providerData?: Record<string, unknown>;
}

export interface ListEarnProgramWithdrawalsInput {
  organizationId: string;
  walletId: string;
  limit: number;
  offset: number;
}

export interface ListEarnProgramWithdrawalsResult {
  rows: EarnProgramWithdrawalRow[];
  total: number;
}

export interface EarnRepository {
  upsertStrategy(input: UpsertEarnStrategyInput): Promise<EarnStrategyRow | null>;
  getStrategyById(strategyId: string): Promise<EarnStrategyRow | null>;
  listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult>;

  /** The org's single shared wallet for a provider+environment, if provisioned. */
  getProviderWallet(params: {
    organizationId: string;
    environment: SdpEnvironment;
    provider: EarnProviderId;
  }): Promise<EarnProviderWalletRow | null>;
  insertProviderWallet(input: InsertEarnProviderWalletInput): Promise<EarnProviderWalletRow | null>;

  createProgramWithdrawal(
    input: CreateEarnProgramWithdrawalInput
  ): Promise<EarnProgramWithdrawalRow | null>;
  /**
   * Replay lookup, WALLET-scoped like the unique index: sibling projects in one
   * environment share the wallet, so a narrower (org, project) anchor would
   * miss replays (see migration 0055's index comment).
   */
  getProgramWithdrawalByRequestId(params: {
    organizationId: string;
    walletId: string;
    requestId: string;
  }): Promise<EarnProgramWithdrawalRow | null>;
  /** Observation lookup — global index; callers assert the org on the write. */
  getProgramWithdrawalByProviderReference(params: {
    provider: string;
    providerReference: string;
  }): Promise<EarnProgramWithdrawalRow | null>;
  updateProgramWithdrawalStatusGuarded(
    input: UpdateEarnProgramWithdrawalStatusGuardedInput
  ): Promise<EarnProgramWithdrawalRow | null>;
  listProgramWithdrawals(
    input: ListEarnProgramWithdrawalsInput
  ): Promise<ListEarnProgramWithdrawalsResult>;
}
