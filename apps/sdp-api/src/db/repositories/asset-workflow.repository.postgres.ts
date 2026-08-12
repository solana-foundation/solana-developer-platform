import type { ReviewMode, WorkflowActionType, WorkflowTriggerType } from "@sdp/types";
import type { AppDb } from "@/db";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import {
  type AssetWorkflowDefinition,
  type AssetWorkflowRow,
  type AssetWorkflowsRepository,
  type CreateAssetWorkflowInput,
  generateAssetWorkflowId,
  type UpdateAssetWorkflowInput,
} from "./asset-workflow.repository";
import {
  deleteWorkflowSecretRetirement,
  insertWorkflowSecretRetirement,
} from "./workflow-secret-retirement.repository.postgres";

// Records, inside the caller's transaction, that a credential this write orphans still
// needs destroying. Only GCP Secret Manager has an external version to destroy — the other
// backends keep the ciphertext inline, so it goes away with the row.
//
// The request still attempts the destroy immediately and clears this row on success; what
// the transaction buys is that a failure of BOTH the destroy and that cleanup can no
// longer lose the orphan, because the obligation was committed by the same statement that
// created it.
// Cancels the provisional obligation recorded before this write was attempted, now that
// the row committed and genuinely references the version.
async function clearQueuedSecret(
  exec: Pick<AppDb, "prepare">,
  stored: StoredCredentialSecret | null | undefined
): Promise<void> {
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  await deleteWorkflowSecretRetirement(exec, stored.secretVersionRef);
}

async function queueOrphanedSecret(
  exec: Pick<AppDb, "prepare">,
  params: {
    organizationId: string;
    workflowId: string;
    retireSecret?: StoredCredentialSecret | null;
    reason: string;
  }
): Promise<void> {
  const stored = params.retireSecret;
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  await insertWorkflowSecretRetirement(exec, {
    organizationId: params.organizationId,
    workflowId: params.workflowId,
    storageBackend: stored.storageBackend,
    secretRef: stored.secretRef ?? null,
    secretVersionRef: stored.secretVersionRef,
    error: params.reason,
  });
}

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
    deleted_at: (row.deleted_at as string | null) ?? null,
  };
}

export function createPostgresAssetWorkflowsRepository(db: AppDb): AssetWorkflowsRepository {
  return {
    async createWorkflow(input: CreateAssetWorkflowInput) {
      const id = input.id ?? generateAssetWorkflowId();
      return db.transaction(async (tx) => {
        const row = await tx
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
        // The rule now references the credential, so the obligation recorded before this
        // insert was attempted is discharged — by this transaction, so a rollback keeps it.
        if (row) {
          await clearQueuedSecret(tx, input.clearRetirementFor);
        }
        return row ? mapWorkflowRow(row) : null;
      });
    },

    async updateWorkflow(input: UpdateAssetWorkflowInput) {
      // One statement, not UPDATE + a separate read-back. The handler's failure path
      // treats a rejection as "nothing committed" and retires the secret version the
      // update would have installed — which is only sound if a rejection really means
      // the row was not written. A second round-trip after the UPDATE could fail with
      // the row already committed, and the catch would then destroy the credential the
      // live rule points at, silently unsigning every later delivery.
      return db.transaction(async (tx) => {
        // The row's own secret, read under lock, is the authority — never the caller's.
        // The handler read the rule outside this transaction, so a rotation that committed
        // in between leaves it naming a version that is already retired: it would queue
        // that one (gone already) and orphan the version the rule actually points at, and
        // an edit that does not resend a secret would write the stale ref back over the
        // rotation, leaving the live rule signing with a destroyed key.
        const locked = await tx
          .prepare(
            `SELECT definition FROM asset_workflows
               WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
               FOR UPDATE`
          )
          .bind(input.workflowId, input.organizationId, input.projectId)
          .first<Record<string, unknown>>();
        if (!locked) {
          return null;
        }
        const currentSecret = (locked.definition as AssetWorkflowDefinition).actionSecret ?? null;
        const definition = input.definition
          ? { ...input.definition, actionSecret: input.rotateSecretTo ?? currentSecret }
          : undefined;

        const row = await tx
          .prepare(
            `UPDATE asset_workflows
               SET definition = COALESCE(?::jsonb, definition),
                   review_mode = COALESCE(?, review_mode),
                   enabled = CASE WHEN ?::boolean THEN ? ELSE enabled END,
                   updated_at = sdp_iso_now()
             WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
             RETURNING *`
          )
          .bind(
            definition ? JSON.stringify(definition) : null,
            input.reviewMode ?? null,
            input.enabled !== undefined,
            input.enabled ?? false,
            input.workflowId,
            input.organizationId,
            input.projectId
          )
          .first<Record<string, unknown>>();
        // Only once the rotation actually landed: a statement that matched nothing left
        // the rule pointing at the version the caller wanted retired, and queueing it
        // would have the sweeper destroy the key the live rule still signs with.
        if (row && input.rotateSecretTo) {
          if (currentSecret?.secretVersionRef !== input.rotateSecretTo.secretVersionRef) {
            await queueOrphanedSecret(tx, {
              organizationId: input.organizationId,
              workflowId: input.workflowId,
              retireSecret: currentSecret,
              reason: "superseded by a key rotation",
            });
          }
          // …and the version this rotation installs is now referenced, so its provisional
          // obligation goes away with the same commit.
          await clearQueuedSecret(tx, input.rotateSecretTo);
        }
        return row ? mapWorkflowRow(row) : null;
      });
    },

    async deleteWorkflow(params) {
      return db.transaction(async (tx) => {
        // Same reason as the update: the caller's view of the stored key predates this
        // transaction, so a rotation that committed in between would have the delete queue
        // an already-retired version and orphan the one the rule really points at.
        // Soft-deleted rows are included — the retry of a delete whose cleanup died still
        // has to find the key it left behind.
        const locked = await tx
          .prepare(
            `SELECT definition FROM asset_workflows
               WHERE id = ? AND organization_id = ? AND project_id = ?
               FOR UPDATE`
          )
          .bind(params.workflowId, params.organizationId, params.projectId)
          .first<Record<string, unknown>>();
        if (!locked) {
          return false;
        }
        const rowsAffected = await tx
          .prepare(
            `UPDATE asset_workflows
               SET deleted_at = sdp_iso_now(), enabled = FALSE, updated_at = sdp_iso_now()
             WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
          )
          .bind(params.workflowId, params.organizationId, params.projectId)
          .run();
        // Queued even when the soft delete matched nothing. That is the retry of a delete
        // whose cleanup died — the rule is already gone and its key still needs retiring,
        // which is the whole point of the retry. Idempotent on the version ref.
        await queueOrphanedSecret(tx, {
          organizationId: params.organizationId,
          workflowId: params.workflowId,
          retireSecret: (locked.definition as AssetWorkflowDefinition).actionSecret,
          reason: "orphaned by a rule delete",
        });
        return rowsAffected > 0;
      });
    },

    async getWorkflowById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM asset_workflows
             WHERE id = ? AND organization_id = ? AND project_id = ?
             ${params.includeDeleted ? "" : "AND deleted_at IS NULL"}`
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
