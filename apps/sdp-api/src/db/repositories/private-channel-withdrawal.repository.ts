import type {
  PrivateChannelTransferContext,
  PrivateChannelTransferStatus,
  PrivateChannelWithdrawal,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelWithdrawalId(): string {
  return `wd_${crypto.randomUUID()}`;
}

export interface PrivateChannelWithdrawalRow {
  id: string;
  organization_id: string;
  project_id: string;
  instance_id: string;
  wallet_id: string;
  owner: string;
  destination: string;
  mint: string;
  amount: string;
  status: PrivateChannelTransferStatus;
  /** Channel-chain burn signature (null until submitted). */
  signature: string | null;
  /** Devnet release signature (null until settled). */
  settlement_ref: string | null;
  failure_reason: string | null;
  /** Read-only audit snapshot; the oracle never reads it. */
  context: PrivateChannelTransferContext;
  /** The caller's `Idempotency-Key`; the tenant-scoped reservation this row claimed. */
  idempotency_key: string | null;
  /** Fingerprint of the request that claimed the key. Null only on pre-header history. */
  idempotency_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface WithdrawalProjectScope {
  organizationId: string;
  projectId: string;
}

export interface CreateWithdrawalInput extends WithdrawalProjectScope {
  instanceId: string;
  walletId: string;
  owner: string;
  destination: string;
  mint: string;
  amount: string;
  /** Audit snapshot at intent time; oracle never reads it. */
  context: PrivateChannelTransferContext;
  /**
   * The reservation. Both fields travel together — the schema rejects one
   * without the other — because a key with no fingerprint could only ever be
   * replayed blind.
   */
  idempotencyKey: string;
  idempotencyFingerprint: string;
}

export interface UpdateWithdrawalInput {
  id: string;
  status: PrivateChannelTransferStatus;
  /** Set on submit; kept when omitted. */
  signature?: string | null;
  /** Set on settle; kept when omitted. */
  settlementRef?: string | null;
  /** Set on failure; kept when omitted. */
  failureReason?: string | null;
  /**
   * Compare-and-swap guard: when set, the update only applies if the row is
   * still in this status. Prevents concurrent pollers from regressing state.
   */
  expectedStatus?: PrivateChannelTransferStatus;
  /**
   * Additionally require that no signature has been persisted yet. Guards the
   * fail path of abandoned-reservation recovery: a decision made from a
   * signatureless snapshot must not land on a row a live request signed in the
   * meantime.
   */
  expectedSignatureAbsent?: boolean;
}

export interface PrivateChannelWithdrawalRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelWithdrawalRepository {
  createWithdrawal(input: CreateWithdrawalInput): Promise<PrivateChannelWithdrawalRow | null>;
  updateWithdrawal(input: UpdateWithdrawalInput): Promise<PrivateChannelWithdrawalRow | null>;
  /**
   * The row that already claimed `idempotencyKey` in this tenant, or null.
   * Scoped to (organization, project) to match the unique index, so one
   * tenant's key can neither collide with nor probe for another's.
   */
  findWithdrawalByIdempotency(
    scope: WithdrawalProjectScope & { idempotencyKey: string }
  ): Promise<PrivateChannelWithdrawalRow | null>;
  getWithdrawalById(
    scope: WithdrawalProjectScope & { id: string }
  ): Promise<PrivateChannelWithdrawalRow | null>;
  listWithdrawalsByProject(scope: WithdrawalProjectScope): Promise<PrivateChannelWithdrawalRow[]>;
  /** Opportunistic sweep of non-terminal withdrawals for a project. */
  listNonTerminalByProject(scope: WithdrawalProjectScope): Promise<PrivateChannelWithdrawalRow[]>;
  /**
   * Global sweep of non-terminal withdrawals, oldest-updated first. Used by the
   * cron reconciler; `limit` caps the per-tick work.
   */
  listNonTerminal(limit: number): Promise<PrivateChannelWithdrawalRow[]>;
  /** Delete guard. */
  countNonTerminalByInstance(instanceId: string): Promise<number>;
  /** Merge `patch` into `context` JSONB atomically (see deposit repo). */
  patchContext(id: string, patch: PrivateChannelTransferContext): Promise<void>;
}

export function mapPrivateChannelWithdrawalRow(
  row: PrivateChannelWithdrawalRow
): PrivateChannelWithdrawal {
  return {
    id: row.id,
    instanceId: row.instance_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    walletId: row.wallet_id,
    owner: row.owner,
    destination: row.destination,
    mint: row.mint,
    amount: row.amount,
    status: row.status,
    signature: row.signature ?? null,
    settlementRef: row.settlement_ref ?? null,
    failureReason: row.failure_reason ?? null,
    context: row.context ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
