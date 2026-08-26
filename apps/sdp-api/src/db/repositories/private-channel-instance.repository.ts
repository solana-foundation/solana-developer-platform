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
  deactivateActive(scope: ProjectScope): Promise<PrivateChannelInstanceRow | null>;
  /** FK ON DELETE CASCADE handles downstream tables. */
  deleteActive(scope: ProjectScope): Promise<boolean>;
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
