import type { PrivateChannelInstance, PrivateChannelInstanceInput } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelInstanceId(): string {
  return `pci_${crypto.randomUUID()}`;
}

export interface PrivateChannelInstanceRow {
  id: string;
  organization_id: string;
  project_id: string;
  gateway_url: string;
  /** Legacy response compatibility only; never used for RPC execution. */
  chain_rpc_url: string;
  escrow_program_id: string;
  withdraw_program_id: string;
  escrow_instance_addr: string;
  auth_url: string;
  is_active: boolean;
  /**
   * When set, the instance is a drain-in-progress: value-movement admission
   * refuses atomically (the admitting INSERTs are guarded on this column), so
   * the in-flight set can only shrink and deletion cannot strand a movement
   * admitted concurrently (HOO-1011).
   */
  draining_at: string | null;
  /**
   * Identity of the current drain episode, minted by `beginDraining` and
   * cleared with `draining_at`. A deletion carries it so it can only ever
   * apply to the drain it started — a timestamp cannot tell one drain from a
   * resume-and-re-drain that lands in the same millisecond.
   */
  draining_token: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectScope {
  organizationId: string;
  projectId: string;
}

export interface FindByGatewayInput extends ProjectScope {
  gatewayUrl: string;
}

export interface CreateActiveInstanceInput extends PrivateChannelInstanceInput, ProjectScope {
  createdBy: string | null;
}

export interface ReactivateInstanceInput extends PrivateChannelInstanceInput {
  id: string;
}

export interface UpdateActiveInstanceInput extends PrivateChannelInstanceInput, ProjectScope {
  id: string;
}

export interface PrivateChannelInstanceRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelInstanceRepository {
  getActiveByProject(scope: ProjectScope): Promise<PrivateChannelInstanceRow | null>;
  /**
   * Load a specific instance by id regardless of is_active. Used by the deposit
   * reconciler so a pending deposit is settled against the exact instance that
   * received it, even if the project has since disconnected/replaced it.
   */
  getById(id: string): Promise<PrivateChannelInstanceRow | null>;
  /** Returns rows regardless of is_active — used to detect a prior connection. */
  findByProjectAndGateway(input: FindByGatewayInput): Promise<PrivateChannelInstanceRow | null>;
  /** Caller must ensure no other active row for this project (409 upstream). */
  createActive(input: CreateActiveInstanceInput): Promise<PrivateChannelInstanceRow | null>;
  reactivateAndUpdate(input: ReactivateInstanceInput): Promise<PrivateChannelInstanceRow | null>;
  /** Updates the currently active row after the caller has verified the proposed connection. */
  updateActive(input: UpdateActiveInstanceInput): Promise<PrivateChannelInstanceRow | null>;
  deactivateActive(scope: ProjectScope): Promise<PrivateChannelInstanceRow | null>;
  /**
   * Flip the active instance into the durable draining state. Idempotent: an
   * already-draining instance is returned as-is, so a deletion retry keeps the
   * original drain timestamp instead of resetting the clock.
   */
  beginDraining(scope: ProjectScope): Promise<PrivateChannelInstanceRow | null>;
  /**
   * Row-lock the active instance for the duration of the caller's transaction.
   * Admission inserts take the same lock, so in-flight counts read after this
   * call cannot grow before the transaction commits.
   *
   * `drainingToken` is the drain this deletion established: the row must still
   * carry it, so a deletion can never apply to an instance an operator resumed
   * (or to a drain some other request started) while it was running.
   */
  lockActiveForDeletion(
    scope: ProjectScope,
    drainingToken: string | null
  ): Promise<PrivateChannelInstanceRow | null>;
  /**
   * FK ON DELETE CASCADE handles downstream tables. Guarded by the same
   * `drainingToken` as the lock, so the delete cannot outlive its own drain —
   * `null` addresses an instance that is not draining at all, which is what
   * the connect-rollback path deletes.
   */
  deleteActive(scope: ProjectScope, drainingToken: string | null): Promise<boolean>;
}

export function mapPrivateChannelInstanceRow(
  row: PrivateChannelInstanceRow
): PrivateChannelInstance {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    gatewayUrl: row.gateway_url,
    chainRpcUrl: row.chain_rpc_url,
    escrowProgramId: row.escrow_program_id,
    withdrawProgramId: row.withdraw_program_id,
    escrowInstanceAddr: row.escrow_instance_addr,
    authUrl: row.auth_url,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
