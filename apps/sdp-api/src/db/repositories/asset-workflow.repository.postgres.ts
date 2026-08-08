import type { ReviewMode, WorkflowActionType, WorkflowTriggerType } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type AssetWorkflowDefinition,
  type AssetWorkflowRow,
  type AssetWorkflowsRepository,
  type CreateAssetWorkflowInput,
  generateAssetWorkflowId,
  type UpdateAssetWorkflowInput,
} from "./asset-workflow.repository";

function mapWorkflowRow(row: Record<string, unknown>): AssetWorkflowRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    token_id: row.token_id as string,
    trigger_type: row.trigger_type as WorkflowTriggerType,
    action_type: row.action_type as WorkflowActionType,
    definition: row.definition as AssetWorkflowDefinition,
    version: Number(row.version),
    enabled: Boolean(row.enabled),
    review_mode: row.review_mode as ReviewMode,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresAssetWorkflowsRepository(db: AppDb): AssetWorkflowsRepository {
  return {
    async createWorkflow(input: CreateAssetWorkflowInput) {
      const id = generateAssetWorkflowId();
      const row = await db
        .prepare(
          `INSERT INTO asset_workflows (
             id, organization_id, project_id, token_id, trigger_type, action_type,
             definition, version, enabled, review_mode, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, COALESCE(?, TRUE), ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.tokenId,
          input.triggerType,
          input.actionType,
          JSON.stringify(input.definition),
          input.version,
          input.enabled ?? null,
          input.reviewMode,
          input.createdBy ?? null
        )
        .first<Record<string, unknown>>();
      return row ? mapWorkflowRow(row) : null;
    },

    async updateWorkflow(input: UpdateAssetWorkflowInput) {
      const rowsAffected = await db
        .prepare(
          `UPDATE asset_workflows
             SET definition = COALESCE(?::jsonb, definition),
                 review_mode = COALESCE(?, review_mode),
                 enabled = CASE WHEN ?::boolean THEN ? ELSE enabled END,
                 updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .bind(
          input.definition ? JSON.stringify(input.definition) : null,
          input.reviewMode ?? null,
          input.enabled !== undefined,
          input.enabled ?? false,
          input.workflowId,
          input.organizationId,
          input.projectId
        )
        .run();
      if (rowsAffected === 0) {
        return null;
      }
      return this.getWorkflowById({
        workflowId: input.workflowId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async deleteWorkflow(params) {
      const rowsAffected = await db
        .prepare(
          `UPDATE asset_workflows
             SET deleted_at = sdp_iso_now(), enabled = FALSE, updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .bind(params.workflowId, params.organizationId, params.projectId)
        .run();
      return rowsAffected > 0;
    },

    async getWorkflowById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM asset_workflows
             WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .bind(params.workflowId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapWorkflowRow(row) : null;
    },

    async listWorkflowsForToken(params) {
      const result = await db
        .prepare(
          `SELECT * FROM asset_workflows
             WHERE token_id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC`
        )
        .bind(params.tokenId, params.organizationId, params.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapWorkflowRow);
    },

    async listEnabledWorkflowsForTrigger(params) {
      const result = await db
        .prepare(
          `SELECT * FROM asset_workflows
             WHERE organization_id = ? AND project_id = ? AND trigger_type = ?
               AND enabled = TRUE AND deleted_at IS NULL
               AND (?::text IS NULL OR token_id = ?)
             ORDER BY created_at ASC
             LIMIT 500`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.triggerType,
          params.tokenId ?? null,
          params.tokenId ?? null
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapWorkflowRow);
    },
  };
}
