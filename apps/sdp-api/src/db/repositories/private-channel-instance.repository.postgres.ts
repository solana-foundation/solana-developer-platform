import type { AppDb } from "@/db";
import {
  type CreateActiveInstanceInput,
  type FindByGatewayInput,
  generatePrivateChannelInstanceId,
  type PrivateChannelInstanceRepository,
  type PrivateChannelInstanceRow,
  type ProjectScope,
  type ReactivateInstanceInput,
} from "./private-channel-instance.repository";

function mapRow(row: Record<string, unknown>): PrivateChannelInstanceRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    gateway_url: row.gateway_url as string,
    chain_rpc_url: row.chain_rpc_url as string,
    escrow_program_id: row.escrow_program_id as string,
    withdraw_program_id: row.withdraw_program_id as string,
    escrow_instance_addr: row.escrow_instance_addr as string,
    auth_url: row.auth_url as string,
    is_active: row.is_active as boolean,
    created_by: (row.created_by ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function selectActive(
  db: AppDb,
  scope: ProjectScope
): Promise<PrivateChannelInstanceRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM private_channel_instances
         WHERE organization_id = ?
           AND project_id = ?
           AND is_active = TRUE`
    )
    .bind(scope.organizationId, scope.projectId)
    .first<Record<string, unknown>>();
  return row ? mapRow(row) : null;
}

export function createPostgresPrivateChannelInstanceRepository(
  db: AppDb
): PrivateChannelInstanceRepository {
  return {
    async getActiveByProject(scope) {
      return selectActive(db, scope);
    },

    async getById(id: string) {
      const row = await db
        .prepare("SELECT * FROM private_channel_instances WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async findByProjectAndGateway(input: FindByGatewayInput) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_instances
             WHERE organization_id = ?
               AND project_id = ?
               AND gateway_url = ?`
        )
        .bind(input.organizationId, input.projectId, input.gatewayUrl)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async createActive(input: CreateActiveInstanceInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_instances (
               id, organization_id, project_id,
               gateway_url,
               escrow_program_id, withdraw_program_id, escrow_instance_addr,
               auth_url,
               is_active, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)
          RETURNING *`
        )
        .bind(
          generatePrivateChannelInstanceId(),
          input.organizationId,
          input.projectId,
          input.gatewayUrl,
          input.escrowProgramId,
          input.withdrawProgramId,
          input.escrowInstanceAddr,
          input.authUrl,
          input.createdBy
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async reactivateAndUpdate(input: ReactivateInstanceInput) {
      const row = await db
        .prepare(
          `UPDATE private_channel_instances
              SET chain_rpc_url = '',
                  escrow_program_id = ?,
                  withdraw_program_id = ?,
                  escrow_instance_addr = ?,
                  auth_url = ?,
                  is_active = TRUE,
                  updated_at = sdp_iso_now()
            WHERE id = ?
          RETURNING *`
        )
        .bind(
          input.escrowProgramId,
          input.withdrawProgramId,
          input.escrowInstanceAddr,
          input.authUrl,
          input.id
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async deactivateActive(scope) {
      const row = await db
        .prepare(
          `UPDATE private_channel_instances
              SET is_active = FALSE,
                  updated_at = sdp_iso_now()
            WHERE organization_id = ?
              AND project_id = ?
              AND is_active = TRUE
          RETURNING *`
        )
        .bind(scope.organizationId, scope.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async deleteActive(scope) {
      const row = await db
        .prepare(
          `DELETE FROM private_channel_instances
            WHERE organization_id = ?
              AND project_id = ?
              AND is_active = TRUE
          RETURNING id`
        )
        .bind(scope.organizationId, scope.projectId)
        .first<{ id: string }>();
      return row !== null;
    },
  };
}
