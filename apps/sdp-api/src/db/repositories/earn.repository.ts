import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnMovementDirection,
  EarnMovementObservationSource,
  EarnPortfolioDepositStatus,
  EarnPortfolioToken,
  EarnProgramMovementRecordStatus,
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

/**
 * Distinct prefix from the withdrawal generator even though both live in one
 * table. Ids stay globally distinguishable, which is what lets `id` act as the
 * pagination tiebreaker across a mixed-direction page.
 */
export function generateEarnProgramDepositId(): string {
  return `earn_program_deposit_${crypto.randomUUID()}`;
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
 * Columns every movement-ledger row carries, whichever direction it is
 * (migration 0057). One table holds both because a movement is a movement; the
 * two arms below split only where the DIRECTIONS genuinely differ.
 */
interface EarnProgramMovementCommonRow {
  id: string;
  organization_id: string;
  wallet_id: string;
  /** Open TEXT, same drift rule as EarnStrategyRow.provider. */
  provider: string;
  status: EarnProgramMovementRecordStatus;
  /** The money that actually moved. Set from the first observation onward. */
  amount_paid_usd: string | null;
  fee_usd: string | null;
  token: EarnPortfolioToken;
  failure_reason: string | null;
  /** Provider withdrawalRef, or the provider's own deposit id. */
  provider_reference: string | null;
  provider_data: Record<string, unknown>;
  created_by: string | null;
  initiated_by_key_id: string | null;
  /** WHICH MECHANISM reported this row's current state — never which provider. */
  observed_via: EarnMovementObservationSource;
  /** When the money MOVED (not when SDP wrote the row). Write-once, and the sort key. */
  occurred_at: string;
  /** Where a deposit came from; rail-gated, so null for an off-Solana arrival. */
  source_address: string | null;
  transaction_signature: string | null;
  transaction_instruction_index: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * A movement SDP INITIATED (migrations 0055, 0057): written at intent (status
 * 'requested') and advanced by guarded CAS on every provider observation — see
 * services/earn-withdrawal-ledger.service.ts for the transition matrix.
 *
 * The four intent fields are non-nullable HERE, on the withdrawal arm, and that
 * is load-bearing rather than cosmetic: `resolveIdempotencyReplay` is generic over
 * `{ idempotency_fingerprint: string | null }` and reads the ROW type, so a flat
 * nullable row would re-open the "null fingerprint = unclaimed" branch that
 * migration 0055 closed by schema. The DB's direction-conditional CHECK and this
 * union brace each other — the same two-layer shape as the CAS guard bracing the
 * appliers' terminal early-return.
 */
export interface EarnProgramWithdrawalRow extends EarnProgramMovementCommonRow {
  direction: "withdrawal";
  project_id: string;
  /** What the caller asked SDP to pay out. Intent, so withdrawal-only. */
  amount_requested_usd: string;
  destination_address: string;
  /** Derived provider request id — the idempotency anchor (wallet-scoped unique). */
  request_id: string;
  idempotency_fingerprint: string;
}

/**
 * A movement SDP OBSERVED (migration 0057): a customer-initiated SPL transfer to
 * the program wallet's funding address. There is no intent moment, so the row is
 * created by whichever mechanism observed it first and may even be born terminal;
 * `services/earn-deposit-ledger.service.ts` owns its transition matrix.
 *
 * Every intent field is `null` by CHECK, not merely by convention: nobody at SDP
 * requested this money, and inventing a project, a user or a requested amount for
 * it would write a fiction a human later reads as fact during an incident.
 */
export interface EarnProgramDepositRow extends EarnProgramMovementCommonRow {
  direction: "deposit";
  project_id: null;
  amount_requested_usd: null;
  destination_address: null;
  request_id: null;
  idempotency_fingerprint: null;
}

export type EarnProgramMovementRow = EarnProgramWithdrawalRow | EarnProgramDepositRow;

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
  fromStatuses: readonly EarnProgramMovementRecordStatus[];
  toStatus: EarnProgramMovementRecordStatus;
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

/**
 * Insert-at-observation: the row is created BY an observation, so unlike the
 * withdrawal insert every field here comes from the observer — including the
 * status (a deposit may be first seen already settled) and `occurredAt` (the
 * movement's own time, NOT now; there is deliberately no DB default for it).
 *
 * `occurredAt`/`completedAt` MUST already be normalized to the fixed-width ISO
 * shape `sdp_iso_now()` emits — see migration 0057's column comment for what a
 * raw provider timestamp corrupts.
 */
export interface InsertEarnProgramDepositInput {
  organizationId: string;
  walletId: string;
  /**
   * Open `string`, unlike every other earn WRITE input. Deliberate: this value is
   * copied from the program's existing `earn_provider_wallets` row rather than
   * chosen by a caller, so narrowing it to the registry union would assert
   * something about a row that already exists — and would force a cast at the only
   * call site. Dispatch still goes through the fail-closed registry before an
   * observation is ever produced.
   */
  provider: string;
  status: EarnPortfolioDepositStatus;
  amountUsd: string;
  token: EarnPortfolioToken;
  providerReference: string | null;
  sourceAddress: string | null;
  transactionSignature: string | null;
  transactionInstructionIndex: number | null;
  observedVia: EarnMovementObservationSource;
  occurredAt: string;
  completedAt: string | null;
  providerData: Record<string, unknown>;
}

/**
 * Guarded CAS for an observed movement. Selector mirrors the identity the
 * observer holds: a provider reference (poll, webhook) or a chain identity
 * (indexer). Same `undefined` = untouched / `null` = written / shallow-JSONB-merge
 * contract as the withdrawal CAS, and the same null-return meaning.
 *
 * `occurredAt` is absent on purpose — it is write-once (migration 0057).
 */
export type UpdateEarnProgramDepositSelector =
  | { depositId: string }
  | { provider: string; providerReference: string }
  | { walletId: string; transactionSignature: string; transactionInstructionIndex: number | null };

export interface UpdateEarnProgramDepositStatusGuardedInput {
  selector: UpdateEarnProgramDepositSelector;
  organizationId: string;
  fromStatuses: readonly EarnProgramMovementRecordStatus[];
  toStatus: EarnPortfolioDepositStatus;
  amountUsd?: string;
  providerReference?: string | null;
  sourceAddress?: string | null;
  transactionSignature?: string | null;
  transactionInstructionIndex?: number | null;
  observedVia?: EarnMovementObservationSource;
  completedAt?: string | null;
  providerData?: Record<string, unknown>;
}

/**
 * The canonical movement read. `direction` is REQUIRED — with both directions in
 * one table, a forgotten predicate returns a plausible wrong number instead of an
 * error, so omitting it has to be a compile error. Pass `"all"` deliberately.
 *
 * Period bounds are half-open `[from, to)`: a closed upper bound double-counts a
 * movement that lands exactly on a boundary into two adjacent periods.
 */
export interface ListEarnProgramMovementsInput {
  organizationId: string;
  walletId: string;
  direction: EarnMovementDirection | "all";
  statuses?: readonly EarnProgramMovementRecordStatus[];
  token?: EarnPortfolioToken;
  occurredFrom?: string;
  occurredTo?: string;
  limit: number;
  offset: number;
}

export interface ListEarnProgramMovementsResult {
  rows: EarnProgramMovementRow[];
  total: number;
}

/**
 * Per-direction netting for a period — the movement half of PRO-1672's
 * "delta balance minus net movements = earnings" identity. Aggregated on
 * `occurred_at`, so a movement observed late still nets into the period it
 * happened in.
 */
export interface SumEarnProgramMovementsInput {
  organizationId: string;
  walletId: string;
  occurredFrom: string;
  occurredTo: string;
  /** Only movements that actually moved money; defaults to the terminal settled set. */
  statuses?: readonly EarnProgramMovementRecordStatus[];
}

export interface EarnProgramMovementSum {
  direction: EarnMovementDirection;
  token: EarnPortfolioToken;
  movementCount: number;
  /** USD decimal string, summed from the settled amount. */
  totalUsd: string;
}

/**
 * Platform-wide, ORGANIZATION-AGNOSTIC program scan for the observation sweep —
 * the only Earn read with no tenant scope, because a platform sweep has no tenant.
 *
 * Keyset over (created_at, id) ASC rather than limit/offset: migration 0056 makes
 * that order stable for a program's whole life, so a keyset scan cannot skip a
 * program because a sibling was created mid-pass — which offset paging would.
 */
export interface ScanEarnProviderWalletsInput {
  environment: SdpEnvironment;
  /** Exclusive cursor: rows strictly after this (createdAt, id). */
  after?: { createdAt: string; id: string };
  limit: number;
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

  /**
   * The observed half (PRO-1669). Deliberately a SEPARATE set of methods from the
   * withdrawal five rather than direction-parameterised ones: every method below
   * pins `direction = 'deposit'` internally, which makes "forgot the direction
   * predicate" — the one real hazard of a unified table — structurally impossible
   * on these paths. The single direction-agnostic read takes it as a required
   * argument instead.
   */
  insertProgramDeposit(input: InsertEarnProgramDepositInput): Promise<EarnProgramDepositRow | null>;
  /** Interim identity: the provider's own deposit id (global partial unique). */
  getProgramDepositByProviderReference(params: {
    provider: string;
    providerReference: string;
  }): Promise<EarnProgramDepositRow | null>;
  /**
   * Chain identity, and the cross-source resolution probe: how a future indexer
   * writer finds the row a poller already wrote, and vice versa. The signature
   * index is NOT unique (one transaction may carry two transfers to one address),
   * so an ambiguous probe returns several rows and the caller must skip rather
   * than guess — never write on a guess.
   */
  listProgramDepositsBySignature(params: {
    walletId: string;
    transactionSignature: string;
  }): Promise<EarnProgramDepositRow[]>;
  updateProgramDepositStatusGuarded(
    input: UpdateEarnProgramDepositStatusGuardedInput
  ): Promise<EarnProgramDepositRow | null>;

  /** The canonical cross-direction movement read; `direction` is required. */
  listProgramMovements(
    input: ListEarnProgramMovementsInput
  ): Promise<ListEarnProgramMovementsResult>;
  /** Per-(direction, token) netting for a period — PRO-1672's movement half. */
  sumProgramMovementsByDirection(
    input: SumEarnProgramMovementsInput
  ): Promise<EarnProgramMovementSum[]>;

  /** Platform-wide program scan for the observation sweep — no tenant scope. */
  scanProviderWallets(input: ScanEarnProviderWalletsInput): Promise<EarnProviderWalletRow[]>;
}
