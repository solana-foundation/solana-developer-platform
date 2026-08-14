// Pure view types + logic for the webhooks section (no fetch, no React) so the
// formatting/validation rules are unit-testable — the approvals `*.data.ts` split.

export type WebhookEndpointStatus = "active" | "disabled";

export interface WebhookEndpointView {
  id: string;
  url: string;
  label: string;
  description: string | null;
  status: WebhookEndpointStatus;
  secretVersion: number;
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryView {
  id: string;
  endpointId: string;
  executionId: string | null;
  workflowId: string | null;
  triggerType: string;
  attempt: number;
  manual: boolean;
  redeliveryOf: string | null;
  requestBody: string;
  requestBodyTruncated: boolean;
  status: "succeeded" | "failed";
  responseStatus: number | null;
  responseBody: string | null;
  responseBodyTruncated: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface CreateWebhookEndpointResult {
  endpoint: WebhookEndpointView;
  // Shown exactly once — never held anywhere but component state.
  secret: string;
}

export interface RotateWebhookSecretResult {
  endpoint: WebhookEndpointView;
  secret: string;
  previousSecretExpiresAt: string | null;
}

// The webhooks section is not in the sidebar — it is reached from an asset's Workflows
// tab, which passes the asset it came from as `?from=`. That value ends up in an href, so
// it is validated against the id shape the issuance routes use rather than trusted: a
// caller-supplied string must never be able to point the back link somewhere else.
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function webhooksOriginTokenId(from: string | undefined): string | null {
  return typeof from === "string" && TOKEN_ID_RE.test(from) ? from : null;
}

export interface WebhookEndpointsPage {
  endpoints: WebhookEndpointView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WebhookDeliveriesPage {
  deliveries: WebhookDeliveryView[];
  total: number;
  page: number;
  pageSize: number;
}

// Mirrors the API's checkWebhookUrlSyntax posture: https-only, a real URL. (The API
// additionally rejects private hosts; that verdict needs DNS, so it stays server-side.)
export function isValidWebhookEndpointUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.length > 0;
}

export type WebhookDeliveryTone = "success" | "error";

export function deliveryTone(delivery: Pick<WebhookDeliveryView, "status">): WebhookDeliveryTone {
  return delivery.status === "succeeded" ? "success" : "error";
}

// The one-cell summary of an attempt: the HTTP status when the receiver answered,
// otherwise the failure code (BLOCKED_URL:*, SECRET_UNAVAILABLE, timeout message…).
// Null when the row carries neither — the caller owns the translated fallback (this
// module is pure, so the raw untranslated status enum must not leak into the UI).
export function deliveryResultLabel(
  delivery: Pick<WebhookDeliveryView, "responseStatus" | "error" | "status">
): string | null {
  if (delivery.responseStatus !== null) {
    return `HTTP ${delivery.responseStatus}`;
  }
  return delivery.error;
}

export function formatDeliveryDuration(durationMs: number | null): string | null {
  if (durationMs === null || Number.isNaN(durationMs)) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

export function deliveriesPageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / pageSize));
}
