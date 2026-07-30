export function generateWebhookDeliveryId(): string {
  return `webhook_delivery_${crypto.randomUUID()}`;
}

export type WebhookDeliveryStatus = "succeeded" | "failed";

export interface WebhookDeliveryRow {
  id: string;
  organization_id: string;
  project_id: string;
  endpoint_id: string;
  execution_id: string | null;
  workflow_id: string | null;
  trigger_type: string;
  attempt: number;
  manual: boolean;
  redelivery_of: string | null;
  request_body: string;
  request_body_truncated: boolean;
  status: WebhookDeliveryStatus;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

// The caller supplies the id so the x-sdp-delivery header sent to the receiver
// matches the logged row.
export interface CreateWebhookDeliveryInput {
  id: string;
  organizationId: string;
  projectId: string;
  endpointId: string;
  executionId?: string | null;
  workflowId?: string | null;
  triggerType: string;
  attempt: number;
  manual?: boolean;
  redeliveryOf?: string | null;
  requestBody: string;
  requestBodyTruncated?: boolean;
  status: WebhookDeliveryStatus;
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
  durationMs?: number | null;
}

export interface WebhookDeliveriesRepository {
  createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRow | null>;
  listDeliveries(params: {
    organizationId: string;
    projectId: string;
    endpointId: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: WebhookDeliveryRow[]; total: number }>;
  getDeliveryById(params: {
    deliveryId: string;
    endpointId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WebhookDeliveryRow | null>;
}
