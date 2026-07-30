import type { AppDb } from "@/db";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import type {
  CreateWebhookEndpointInput,
  WebhookEndpointRow,
  WebhookEndpointStatus,
  WebhookEndpointsRepository,
} from "./webhook-endpoint.repository";

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
      const row = await db
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
      return row ? mapEndpointRow(row) : null;
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
             ORDER BY created_at DESC
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
      const rowsAffected = await db
        .prepare(
          `UPDATE webhook_endpoints
             SET deleted_at = sdp_iso_now(), status = 'disabled', updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .bind(params.endpointId, params.organizationId, params.projectId)
        .run();
      return rowsAffected > 0;
    },

    async rotateSecret(params) {
      const row = await db
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
          params.previousSecretStorage ? JSON.stringify(params.previousSecretStorage) : null,
          params.previousSecretExpiresAt ?? null,
          params.endpointId,
          params.organizationId,
          params.projectId
        )
        .first<Record<string, unknown>>();
      return row ? mapEndpointRow(row) : null;
    },
  };
}
