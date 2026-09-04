import type {
  FailureCode,
  OperationState,
  OpType,
  PrivateOperationSummary,
  TransferMode,
} from "@sdp/helius-rings";
import type { RepositoryDbClient } from "./base";
import type { HeliusRingsProjectScope } from "./helius-rings-wallet.repository";

export function generateHeliusRingsOperationId(): string {
  return `hro_${crypto.randomUUID()}`;
}

/** Upper bound on an unpaginated activity read. */
export const DEFAULT_RINGS_OPERATION_LIST_LIMIT = 50;

/** Upper bound on one pass of the resume sweep. */
export const DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT = 100;

export interface HeliusRingsOperationRow {
  id: string;
  organization_id: string;
  project_id: string;
  wallet_id: string;
  op_type: OpType;
  state: OperationState;
  asset_mint: string | null;
  amount_raw: string | null;
  from_addr: string | null;
  to_addr: string | null;
  zone_id: string | null;
  transfer_mode: TransferMode | null;
  /** Ring the operation was pinned to at prepare; NULL = the default public ring. */
  ring_program_id: string | null;
  intent_key: string;
  approval_request_id: string | null;
  policy_evaluation_id: string | null;
  proof_source: "simulated" | "live" | null;
  proof_ref: string | null;
  outer_tx_signature: string | null;
  photon_indexed_at: string | null;
  failure_code: FailureCode | null;
  failure_message: string | null;
  retryable: boolean | null;
  retry_of_operation_id: string | null;
  /** Denormalized from `helius_rings_timelocks`; that table stays the authority. */
  timelock_unlock_at: string | null;
  /**
   * The note commitments this operation's build committed to spending. Null
   * before the first build, and for a shield, which creates notes instead.
   */
  input_notes: string[] | null;
  /** base64 signed outer transaction; the exact bytes a recovery resubmits. */
  signed_transaction: string | null;
  /** uint64 as a string. Past this height the signed bytes can never land. */
  last_valid_block_height: string | null;
  submission_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HeliusRingsTimelockRow {
  operation_id: string;
  unlock_at: string;
  released_at: string | null;
  beneficiary_addr: string;
}

export interface HeliusRingsTimelockInput {
  unlockAt: string;
  beneficiaryAddr: string;
}

/**
 * The intent as the caller described it. `intentKey` is computed upstream — the
 * repository takes it as given rather than deriving it, so the hashing rule
 * lives in one place (the service) instead of being duplicated behind a column.
 */
export interface ReserveHeliusRingsIntentInput extends HeliusRingsProjectScope {
  walletId: string;
  opType: OpType;
  intentKey: string;
  assetMint?: string | null;
  amountRaw?: string | null;
  fromAddr?: string | null;
  toAddr?: string | null;
  zoneId?: string | null;
  transferMode?: TransferMode | null;
  /** Resolved by the service before reserving; immutable for the operation's life. */
  ringProgramId?: string | null;
  retryOfOperationId?: string | null;
  /** Required for `timelock_create`; writes the escrow row and the denormalized column. */
  timelock?: HeliusRingsTimelockInput | null;
}

export interface ReserveHeliusRingsIntentResult {
  operation: HeliusRingsOperationRow;
  /**
   * False when the intent key was already taken and `operation` is the row that
   * was there. Callers use this to skip re-doing side effects on a replay — the
   * whole point of the idempotency contract.
   */
  reserved: boolean;
}

/**
 * Optional columns a transition may set on its way through. Each is written only
 * when present, so a transition never blanks a field an earlier step recorded.
 */
export interface HeliusRingsOperationTransitionPatch {
  approvalRequestId?: string | null;
  policyEvaluationId?: string | null;
  proofSource?: "simulated" | "live" | null;
  proofRef?: string | null;
  outerTxSignature?: string | null;
  photonIndexedAt?: string | null;
  /** The notes the build committed to; recorded on the way out of `proving`. */
  inputNotes?: string[] | null;
}

/**
 * Records the signed bytes before they are broadcast.
 *
 * Separate from a transition because the ordering is the point: the signature
 * is derivable from the bytes without the network, so it is knowable before the
 * RPC call and must be durable before it. Broadcasting first would leave a live
 * transaction whose bytes were never recorded, and nothing sweeps for those.
 */
export interface PersistHeliusRingsSignedInput extends HeliusRingsProjectScope {
  id: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
}

export interface TransitionHeliusRingsOperationInput extends HeliusRingsProjectScope {
  id: string;
  /** Compare-and-swap guard; the update is skipped unless the locked row still reads this. */
  expectedState: OperationState;
  nextState: OperationState;
  patch?: HeliusRingsOperationTransitionPatch;
}

export interface FailHeliusRingsOperationInput extends HeliusRingsProjectScope {
  id: string;
  expectedState: OperationState;
  code: FailureCode;
  message: string;
  retryable: boolean;
}

export interface ListHeliusRingsOperationsByWalletInput extends HeliusRingsProjectScope {
  walletId: string;
  limit?: number;
}

export interface ListHeliusRingsOperationsByProjectInput extends HeliusRingsProjectScope {
  limit?: number;
  /** Undefined is unrestricted; an explicit empty allowlist matches nothing. */
  walletIds?: readonly string[];
}

export interface HeliusRingsExpiredSubmissionsInput {
  /** Current chain height; a row is expired once its expiry is below this. */
  blockHeight: string;
  limit?: number;
}

export interface ListHeliusRingsInFlightOperationsInput {
  /** Only operations untouched since this ISO-8601 instant, so a fresh write is not swept mid-flight. */
  staleBefore: string;
  limit?: number;
}

export interface ReleaseHeliusRingsTimelockInput {
  operationId: string;
  releasedAt: string;
}

export interface HeliusRingsOperationRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsOperationRepository {
  /**
   * The idempotency entry point. Inserts the operation, or returns the one the
   * intent key already names — a retried request must never open a second
   * shielded operation, because the caller has no way to tell the duplicate
   * apart afterwards and both would move funds.
   */
  reserveIntent(input: ReserveHeliusRingsIntentInput): Promise<ReserveHeliusRingsIntentResult>;
  getOperationById(
    input: HeliusRingsProjectScope & { id: string }
  ): Promise<HeliusRingsOperationRow | null>;
  getOperationByIntentKey(
    input: HeliusRingsProjectScope & { intentKey: string }
  ): Promise<HeliusRingsOperationRow | null>;
  listOperationsByWallet(
    input: ListHeliusRingsOperationsByWalletInput
  ): Promise<HeliusRingsOperationRow[]>;
  listOperationsByProject(
    input: ListHeliusRingsOperationsByProjectInput
  ): Promise<HeliusRingsOperationRow[]>;
  /**
   * Advances one operation under `SELECT ... FOR UPDATE`. Returns null when the
   * guard loses — either the row moved on already or it is not in this tenant —
   * leaving the row untouched.
   */
  transitionState(
    input: TransitionHeliusRingsOperationInput
  ): Promise<HeliusRingsOperationRow | null>;
  /**
   * Writes the signature and exact bytes only while the row is ready to sign,
   * refusing if any are already there.
   *
   * The refusal is what makes it safe to call on a retried execution: a second
   * signing of the same operation would produce different bytes for the same
   * intent, and whichever set was broadcast second could land alongside the
   * first.
   */
  persistSigned(input: PersistHeliusRingsSignedInput): Promise<HeliusRingsOperationRow | null>;
  /** Marks the broadcast durably begun. Null unless signed bytes are present. */
  markSubmissionStarted(
    input: HeliusRingsProjectScope & { id: string; at: string }
  ): Promise<HeliusRingsOperationRow | null>;
  /**
   * Submitted operations whose signed bytes can no longer land, for the sweep
   * that escalates them to `manual_reconciliation_required`.
   */
  listExpiredSubmissions(
    input: HeliusRingsExpiredSubmissionsInput
  ): Promise<HeliusRingsOperationRow[]>;
  /**
   * The operation, if any, that blocks a new one of these types.
   *
   * A targeted query rather than a scan of the wallet's recent page: the row
   * being looked for is by definition old — it has been stuck since it failed —
   * and enough later operations will push it out of any window. Missing it
   * would let the database's unique index catch the duplicate instead, which
   * reports a constraint name rather than the situation.
   */
  findBlockingOperation(
    input: HeliusRingsProjectScope & { walletId: string; opTypes: readonly string[] }
  ): Promise<HeliusRingsOperationRow | null>;
  /**
   * `failed` → `completed`, for a signed failure Photon turns out to hold.
   *
   * Deliberately not a `nextState` edge. `executeOperation` drives the state
   * machine, and making `failed` a legal source there would let any worker
   * complete a signed failure without having asked Photon first.
   *
   * Nulls the failure triple in the same statement because the schema requires
   * it: those columns exist exactly for `failed` and `voided`.
   */
  completeFromFailed(
    input: HeliusRingsProjectScope & { id: string; photonIndexedAt: string }
  ): Promise<HeliusRingsOperationRow | null>;
  /**
   * `failed` → `voided`, for a signed failure confirmed never to have landed.
   *
   * Keeps the failure triple and the signed bytes: the triple is why an
   * operator was involved, and the bytes are how a later dispute is answered.
   * Releases the wallet purely by leaving the states the unique indexes name.
   */
  voidOperation(
    input: HeliusRingsProjectScope & { id: string }
  ): Promise<HeliusRingsOperationRow | null>;
  /** Signed failures, for the pass that completes the ones Photon now holds. */
  listSignedFailures(input: { limit?: number }): Promise<HeliusRingsOperationRow[]>;
  /** Signed failures whose blockhash has expired and that still name a resolvable code. */
  listExpiredSignedFailures(
    input: HeliusRingsExpiredSubmissionsInput
  ): Promise<HeliusRingsOperationRow[]>;
  /**
   * Rewrites a signed failure's code to `manual_reconciliation_required`, in place.
   *
   * State and failure_message stay put — the original message names the actual
   * reason. Only failure_code and retryable move.
   */
  escalateToManualReconciliation(
    input: HeliusRingsProjectScope & { id: string }
  ): Promise<HeliusRingsOperationRow | null>;
  /**
   * Terminal failure. Writes the full failure triple the DB CHECK requires.
   * A ready-to-sign failure loses if signed bytes won the row lock first.
   */
  failOperation(input: FailHeliusRingsOperationInput): Promise<HeliusRingsOperationRow | null>;
  /** Resume sweep feed: non-terminal operations, oldest touched first. */
  listInFlightOperations(
    input: ListHeliusRingsInFlightOperationsInput
  ): Promise<HeliusRingsOperationRow[]>;
  getTimelock(input: { operationId: string }): Promise<HeliusRingsTimelockRow | null>;
  /** Escrows whose unlock time has passed and that are still held. */
  listReleasableTimelocks(input: {
    asOf: string;
    limit?: number;
  }): Promise<HeliusRingsTimelockRow[]>;
  /**
   * Marks one escrow released. Returns null if it was already released, so a
   * double sweep cannot pay a beneficiary twice.
   */
  releaseTimelock(input: ReleaseHeliusRingsTimelockInput): Promise<HeliusRingsTimelockRow | null>;
}

/**
 * Row to the list-shaped domain projection. The activity table renders this;
 * the full `PrivateOperation` needs the event feed joined in, which the service
 * assembles.
 */
export function mapHeliusRingsOperationSummaryRow(
  row: HeliusRingsOperationRow
): PrivateOperationSummary {
  return {
    id: row.id,
    walletId: row.wallet_id,
    opType: row.op_type,
    state: row.state,
    assetMint: row.asset_mint ?? null,
    amountRaw: row.amount_raw ?? null,
    ringProgramId: row.ring_program_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureCode: row.failure_code ?? null,
    outerTxSignature: row.outer_tx_signature ?? null,
    retryable: row.retryable ?? null,
    retryOfOperationId: row.retry_of_operation_id ?? null,
  };
}
