import type { AppDb } from "@/db";
import type {
  CreateWebhookDeliveryInput,
  WebhookDeliveriesRepository,
  WebhookDeliveryRow,
  WebhookDeliveryStatus,
} from "./webhook-delivery.repository";

function mapDeliveryRow(row: Record<string, unknown>): WebhookDeliveryRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    endpoint_id: row.endpoint_id as string,
    execution_id: (row.execution_id as string | null) ?? null,
    workflow_id: (row.workflow_id as string | null) ?? null,
    trigger_type: row.trigger_type as string,
    attempt: Number(row.attempt),
    manual: Boolean(row.manual),
    redelivery_of: (row.redelivery_of as string | null) ?? null,
    request_body: row.request_body as string,
    request_body_truncated: Boolean(row.request_body_truncated),
    status: row.status as WebhookDeliveryStatus,
    response_status: row.response_status === null ? null : Number(row.response_status),
    response_body: (row.response_body as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    created_at: row.created_at as string,
  };
}

export function createPostgresWebhookDeliveriesRepository(db: AppDb): WebhookDeliveriesRepository {
  return {
    async createDelivery(input: CreateWebhookDeliveryInput) {
      const row = await db
        .prepare(
          `INSERT INTO webhook_deliveries (
             id, organization_id, project_id, endpoint_id, execution_id, workflow_id,
             trigger_type, attempt, manual, redelivery_of, request_body,
             request_body_truncated, status, response_status, response_body, error, duration_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.endpointId,
          input.executionId ?? null,
          input.workflowId ?? null,
          input.triggerType,
          input.attempt,
          input.manual ?? false,
          input.redeliveryOf ?? null,
          input.requestBody,
          input.requestBodyTruncated ?? false,
          input.status,
          input.responseStatus ?? null,
          input.responseBody ?? null,
          input.error ?? null,
          input.durationMs ?? null
        )
        .first<Record<string, unknown>>();
      return row ? mapDeliveryRow(row) : null;
    },

    async listDeliveries(params) {
      const countRow = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM webhook_deliveries
             WHERE organization_id = ? AND project_id = ? AND endpoint_id = ?`
        )
        .bind(params.organizationId, params.projectId, params.endpointId)
        .first<{ total: number }>();
      const result = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
             WHERE organization_id = ? AND project_id = ? AND endpoint_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.endpointId,
          params.limit,
          params.offset
        )
        .all<Record<string, unknown>>();
      return {
        rows: result.results.map(mapDeliveryRow),
        total: Number(countRow?.total ?? 0),
      };
    },

    async getDeliveryById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
             WHERE id = ? AND endpoint_id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(params.deliveryId, params.endpointId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapDeliveryRow(row) : null;
    },
  };
}
