import type {
  PrivateChannelDeposit,
  PrivateChannelTransferContext,
  PrivateChannelTransferStatus,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelDepositId(): string {
  return `dep_${crypto.randomUUID()}`;
}

export interface PrivateChannelDepositRow {
  id: string;
  organization_id: string;
  project_id: string;
  instance_id: string;
  wallet_id: string;
  depositor: string;
  recipient: string;
  mint: string;
  amount: string;
  status: PrivateChannelTransferStatus;
  signature: string | null;
  settlement_ref: string | null;
  failure_reason: string | null;
  /** Read-only audit snapshot; the oracle never reads it. */
  context: PrivateChannelTransferContext;
  created_at: string;
  updated_at: string;
}

export interface DepositProjectScope {
  organizationId: string;
  projectId: string;
}

export interface CreateDepositInput extends DepositProjectScope {
  instanceId: string;
  walletId: string;
  depositor: string;
  recipient: string;
  mint: string;
  amount: string;
  /** Audit snapshot at intent time; oracle never reads it. */
  context: PrivateChannelTransferContext;
}

export interface UpdateDepositInput {
  id: string;
  status: PrivateChannelTransferStatus;
  /** Set on submit; kept when omitted. */
  signature?: string | null;
  /** Set when advancing to settled. */
  settlementRef?: string | null;
  /** Set on failure; kept when omitted. */
  failureReason?: string | null;
  /**
   * Compare-and-swap guard: when set, the update only applies if the row is
   * still in this status. Prevents concurrent pollers from regressing state.
   */
  expectedStatus?: PrivateChannelTransferStatus;
}

export interface PrivateChannelDepositRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelDepositRepository {
  createDeposit(input: CreateDepositInput): Promise<PrivateChannelDepositRow | null>;
  updateDeposit(input: UpdateDepositInput): Promise<PrivateChannelDepositRow | null>;
  getDepositById(
    scope: DepositProjectScope & { id: string }
  ): Promise<PrivateChannelDepositRow | null>;
  listDepositsByProject(scope: DepositProjectScope): Promise<PrivateChannelDepositRow[]>;
  /** Opportunistic sweep of non-terminal deposits for a project. */
  listNonTerminalByProject(scope: DepositProjectScope): Promise<PrivateChannelDepositRow[]>;
  /**
   * Global sweep of non-terminal deposits, oldest-updated first. Used by the
   * cron reconciler; `limit` caps the per-tick work.
   */
  listNonTerminal(limit: number): Promise<PrivateChannelDepositRow[]>;
  /** Delete guard: an instance can't be deleted while deposits are in flight. */
  countNonTerminalByInstance(instanceId: string): Promise<number>;
  /**
   * Merge `patch` into `context` JSONB atomically. Used by the oracle to record
   * debounce markers (e.g. lastStuckWarningAt) without racing the poll update.
   */
  patchContext(id: string, patch: PrivateChannelTransferContext): Promise<void>;
}

export function mapPrivateChannelDepositRow(row: PrivateChannelDepositRow): PrivateChannelDeposit {
  return {
    id: row.id,
    instanceId: row.instance_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    walletId: row.wallet_id,
    depositor: row.depositor,
    recipient: row.recipient,
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
