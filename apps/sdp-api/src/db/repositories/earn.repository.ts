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
 * Link to ONE provider-managed wallet — an Earn "program". An organization may
 * hold N of them per (environment, provider) since PRO-1670; each pins a single
 * vault and nothing rebalances across them. The uniqueness that used to cap this
 * at one row per (organization, environment, provider) is gone (migration 0056),
 * replaced by a GLOBAL UNIQUE (provider, provider_wallet_ref): a provider-side
 * wallet holds real funds, so exactly one link row may claim it platform-wide.
 *
 * project_id records the provisioning project only — it is not part of the
 * program's scope, and every project in an environment reaches every program.
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

/**
 * Provider-reference prefix the dev seed stamps on every fixture row it writes
 * (apps/sdp-api/scripts/seed-earn-demo.ts). Canonical HERE, not in the script,
 * because it partitions this table's key space and the delist pass has to honour
 * that partition: providers only ever list their own bare ids, so a prefixed row
 * is by construction not a row any provider can confirm or deny.
 */
export const EARN_SEED_REFERENCE_PREFIX = "seed-demo-";

/**
 * Delist pass input: everything the provider still lists for (provider,
 * environment). Anything else the table holds is stale — a vault the provider
 * delisted, or one a tightened catalogue gate now refuses (the
 * `not_solana_hosted` case) — and is deleted.
 *
 * `listedProviderReferences` is the KEEP set, never the delete set, so the
 * caller cannot enumerate stale rows it does not know about: the provider's
 * live list is the only input, and the DB decides what that leaves behind.
 */
export interface DeleteUnlistedEarnStrategiesInput {
  provider: EarnProviderId;
  environment: SdpEnvironment;
  listedProviderReferences: readonly string[];
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

export interface ListEarnProviderWalletsInput {
  organizationId: string;
  environment: SdpEnvironment;
  /** Optional filter; omitted lists every provider's programs. */
  provider?: EarnProviderId;
  limit: number;
  offset: number;
}

export interface ListEarnProviderWalletsResult {
  rows: EarnProviderWalletRow[];
  total: number;
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
  /**
   * DELETE every `active` strategy for (provider, environment) that the provider
   * no longer lists. Returns the deleted provider references so the caller can
   * log exactly what left the catalogue. Idempotent: a second pass over the same
   * keep set matches nothing.
   *
   * Deleted, not flagged: this table is a cache of the provider catalogue (the
   * sync is its only writer besides the dev seed) and nothing references a
   * strategy id — no foreign key, and a program's allocations carry the
   * PROVIDER's reference, resolved against Ground's live response. A status flag
   * would leave rows SDP must not carry sitting in the table indefinitely.
   */
  deleteUnlistedStrategies(input: DeleteUnlistedEarnStrategiesInput): Promise<string[]>;

  /**
   * One program by its own id, scoped to (organization, environment). The
   * program id is caller-supplied on every `/programs/:programId` route, so both
   * scopes are load-bearing: without organization_id a guessed id reads another
   * tenant's program, and without environment a sandbox id resolves for a
   * production session (the pre-PRO-1670 (org, environment, provider) lookup made
   * both structurally impossible; an addressable id does not).
   */
  getProviderWalletById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    walletId: string;
  }): Promise<EarnProviderWalletRow | null>;
  /**
   * Every program for an (organization, environment), oldest first. The order is
   * a stability requirement, not a preference — see migration 0056's header.
   */
  listProviderWallets(input: ListEarnProviderWalletsInput): Promise<ListEarnProviderWalletsResult>;
  /**
   * Lookup by the provider-side wallet ref, keyed on 0056's global unique. Two
   * callers need it and neither has an organization to scope by: the create path
   * resolves a provider replay (the provider answers a retried create with the
   * ORIGINAL ref, so the insert lands on that unique and the row it collided with
   * IS the caller's program), and the dev seed asks whether the shared sandbox
   * wallet is already linked anywhere. Callers assert ownership after the fetch,
   * exactly as getProgramWithdrawalByProviderReference does.
   */
  getProviderWalletByRef(params: {
    provider: EarnProviderId;
    providerWalletRef: string;
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
