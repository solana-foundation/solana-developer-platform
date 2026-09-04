import type { AppDb } from "@/db";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import type {
  CreateWebhookEndpointInput,
  WebhookEndpointRow,
  WebhookEndpointStatus,
  WebhookEndpointsRepository,
} from "./webhook-endpoint.repository";
import {
  deleteWorkflowSecretRetirement,
  insertWorkflowSecretRetirement,
} from "./workflow-secret-retirement.repository.postgres";

// Cancels, inside the caller's transaction, the provisional obligation recorded before this
// write was attempted — the row now genuinely references the version.
async function clearQueuedSecret(
  exec: Pick<AppDb, "prepare">,
  stored: StoredCredentialSecret | null | undefined
): Promise<void> {
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  await deleteWorkflowSecretRetirement(exec, stored.secretVersionRef);
}

// Records, inside the caller's transaction, that a version this write drops out of the row
// still needs destroying. Committed by the same statement that orphans it, so a failure of
// both the immediate destroy and its bookkeeping can no longer lose the credential.
//
// The queue is shared with rule secrets and has no endpoint column, so `workflow_id` is
// null; the version stays traceable because its `secret_ref` is keyed by endpoint id.
async function queueOrphanedSecret(
  exec: Pick<AppDb, "prepare">,
  params: {
    organizationId: string;
    retireSecret: StoredCredentialSecret | null | undefined;
    reason: string;
  }
): Promise<void> {
  const stored = params.retireSecret;
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  await insertWorkflowSecretRetirement(exec, {
    organizationId: params.organizationId,
    workflowId: null,
    storageBackend: stored.storageBackend,
    secretRef: stored.secretRef ?? null,
    secretVersionRef: stored.secretVersionRef,
    error: params.reason,
  });
}

// One entry per version ref. Current and previous are distinct in every real rotation, but
// deduping keeps a degenerate row from being queued — and then destroyed — twice.
function distinctHandles(
  handles: (StoredCredentialSecret | null | undefined)[]
): StoredCredentialSecret[] {
  const byRef = new Map<string, StoredCredentialSecret>();
  for (const handle of handles) {
    if (handle?.secretVersionRef) {
      byRef.set(handle.secretVersionRef, handle);
    }
  }
  return [...byRef.values()];
}

function mapEndpointRow(row: Record<string, unknown>): WebhookEndpointRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    url: row.url as string,
    label: row.label as string,
    description: (row.description as string | null) ?? null,
    status: row.status as WebhookEndpointStatus,
    secret_storage: row.secret_storage as StoredCredentialSecret,
    previous_secret_storage: (row.previous_secret_storage as StoredCredentialSecret | null) ?? null,
    previous_secret_expires_at: (row.previous_secret_expires_at as string | null) ?? null,
    secret_version: Number(row.secret_version),
    created_by: (row.created_by as string | null) ?? null,
    deleted_at: (row.deleted_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresWebhookEndpointsRepository(db: AppDb): WebhookEndpointsRepository {
  return {
    async createEndpoint(input: CreateWebhookEndpointInput) {
      return db.transaction(async (tx) => {
        const row = await tx
          .prepare(
            `INSERT INTO webhook_endpoints (
               id, organization_id, project_id, url, label, description, secret_storage, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)
             RETURNING *`
          )
          .bind(
            input.id,
            input.organizationId,
            input.projectId,
            input.url,
            input.label,
            input.description ?? null,
            JSON.stringify(input.secretStorage),
            input.createdBy ?? null
          )
          .first<Record<string, unknown>>();
        // The endpoint now references the credential, so the obligation recorded before
        // this insert was attempted is discharged — by this transaction, so a rollback
        // keeps it and the sweeper destroys the version nothing ended up pointing at.
        if (row) {
          await clearQueuedSecret(tx, input.clearRetirementFor);
        }
        return row ? mapEndpointRow(row) : null;
      });
    },

    async getEndpointById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM webhook_endpoints
             WHERE id = ? AND organization_id = ? AND project_id = ?
               AND (?::boolean OR deleted_at IS NULL)`
        )
        .bind(
          params.endpointId,
          params.organizationId,
          params.projectId,
          params.includeDeleted === true
        )
        .first<Record<string, unknown>>();
      return row ? mapEndpointRow(row) : null;
    },

    async listEndpoints(params) {
      const countRow = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM webhook_endpoints
             WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .bind(params.organizationId, params.projectId)
        .first<{ total: number }>();
      const result = await db
        .prepare(
          `SELECT * FROM webhook_endpoints
             WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(params.organizationId, params.projectId, params.limit, params.offset)
        .all<Record<string, unknown>>();
      return {
        rows: result.results.map(mapEndpointRow),
        total: Number(countRow?.total ?? 0),
      };
    },

    async updateEndpoint(params) {
      const row = await db
        .prepare(
          `UPDATE webhook_endpoints
             SET label = COALESCE(?, label),
                 description = CASE WHEN ?::boolean THEN ? ELSE description END,
                 status = COALESCE(?, status),
                 updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
           RETURNING *`
        )
        .bind(
          params.label ?? null,
          params.description !== undefined,
          params.description ?? null,
          params.status ?? null,
          params.endpointId,
          params.organizationId,
          params.projectId
        )
        .first<Record<string, unknown>>();
      return row ? mapEndpointRow(row) : null;
    },

    async softDeleteEndpoint(params) {
      return db.transaction(async (tx) => {
        // Read under lock, and soft-deleted rows included on purpose: the retry of a delete
        // whose cleanup died still has to find the keys it left behind, which is the whole
        // point of the retry.
        const locked = await tx
          .prepare(
            `SELECT secret_storage, previous_secret_storage FROM webhook_endpoints
               WHERE id = ? AND organization_id = ? AND project_id = ?
               FOR UPDATE`
          )
          .bind(params.endpointId, params.organizationId, params.projectId)
          .first<Record<string, unknown>>();
        if (!locked) {
          return { deleted: false, retired: [] };
        }
        // Both keys stop being referenced the instant this commits: nothing signs with a
        // deleted endpoint, and the delivery log the soft delete preserves holds bodies,
        // never secrets.
        const retired = distinctHandles([
          locked.secret_storage as StoredCredentialSecret | null,
          locked.previous_secret_storage as StoredCredentialSecret | null,
        ]);
        const rowsAffected = await tx
          .prepare(
            `UPDATE webhook_endpoints
               SET deleted_at = sdp_iso_now(), status = 'disabled', updated_at = sdp_iso_now()
             WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
          )
          .bind(params.endpointId, params.organizationId, params.projectId)
          .run();
        // Queued even when the soft delete matched nothing — that is the retry described
        // above, where the row is already gone and its keys still need retiring.
        // Idempotent on the version ref.
        for (const stored of retired) {
          await queueOrphanedSecret(tx, {
            organizationId: params.organizationId,
            retireSecret: stored,
            reason: "orphaned by a webhook endpoint delete",
          });
        }
        return { deleted: rowsAffected > 0, retired };
      });
    },

    async rotateSecret(params) {
      return db.transaction(async (tx) => {
        // The row's own handles, read under lock, are the authority — never the caller's.
        // The handler read the endpoint outside this transaction, so a rotation that
        // committed in between leaves its view naming a version already retired: it would
        // write that one back as the live grace key and orphan the one the row actually
        // holds, leaving the endpoint signing with a destroyed secret.
        const locked = await tx
          .prepare(
            `SELECT secret_storage, previous_secret_storage FROM webhook_endpoints
               WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
               FOR UPDATE`
          )
          .bind(params.endpointId, params.organizationId, params.projectId)
          .first<Record<string, unknown>>();
        if (!locked) {
          return null;
        }
        const current = locked.secret_storage as StoredCredentialSecret;
        const previous = (locked.previous_secret_storage as StoredCredentialSecret | null) ?? null;
        const keepGrace = params.previousSecretExpiresAt !== null;
        // Whatever occupied the previous slot is displaced for good by this rotation. With
        // no grace window the outgoing current key is displaced too, rather than staying
        // live for receivers mid-cutover.
        const retired = distinctHandles([previous, keepGrace ? null : current]);

        const row = await tx
          .prepare(
            `UPDATE webhook_endpoints
               SET secret_storage = ?::jsonb,
                   previous_secret_storage = ?::jsonb,
                   previous_secret_expires_at = ?,
                   secret_version = secret_version + 1,
                   updated_at = sdp_iso_now()
             WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
             RETURNING *`
          )
          .bind(
            JSON.stringify(params.secretStorage),
            keepGrace ? JSON.stringify(current) : null,
            params.previousSecretExpiresAt,
            params.endpointId,
            params.organizationId,
            params.projectId
          )
          .first<Record<string, unknown>>();
        if (!row) {
          return null;
        }
        // Only now that the rotation has actually landed. Queueing these against a
        // statement that matched nothing would leave the row still pointing at them and
        // have the sweeper destroy keys the live endpoint signs with.
        for (const stored of retired) {
          await queueOrphanedSecret(tx, {
            organizationId: params.organizationId,
            retireSecret: stored,
            reason: "superseded by a webhook endpoint key rotation",
          });
        }
        // …and the version this rotation installs is now referenced, so its provisional
        // obligation goes away with the same commit.
        await clearQueuedSecret(tx, params.secretStorage);
        return { row: mapEndpointRow(row), retired };
      });
    },
  };
}
