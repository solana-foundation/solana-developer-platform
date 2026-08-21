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
  /** Terminal failure. Writes the full failure triple the DB CHECK requires. */
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
    opType: row.op_type,
    state: row.state,
    assetMint: row.asset_mint ?? null,
    amountRaw: row.amount_raw ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
