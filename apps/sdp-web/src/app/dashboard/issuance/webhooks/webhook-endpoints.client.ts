// BFF fetchers/mutations for the webhooks section: throw on failure so they plug
// straight into SWR, and unwrap the sdp-api `{ data, meta }` envelope.

import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";
import type {
  CreateWebhookEndpointResult,
  RotateWebhookSecretResult,
  WebhookDeliveriesPage,
  WebhookDeliveryView,
  WebhookEndpointStatus,
  WebhookEndpointsPage,
  WebhookEndpointView,
} from "./webhook-endpoints.data";

const BASE = "/api/dashboard/webhook-endpoints";

function unwrap<T>(result: DashboardFetchResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data;
}

function requireField<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Invalid response");
  }
  return value;
}

// `total` travels with every page so callers can tell a full listing from a capped
// one (the builder picker fetches one page and must say when more exist).
export async function fetchWebhookEndpoints(
  page = 1,
  pageSize = 100
): Promise<WebhookEndpointsPage> {
  const body = unwrap(
    await dashboardFetch<{
      data?: WebhookEndpointView[];
      meta?: { total?: number; page?: number; pageSize?: number };
    }>(`${BASE}?page=${page}&pageSize=${pageSize}`)
  );
  return {
    endpoints: body?.data ?? [],
    total: body?.meta?.total ?? 0,
    page: body?.meta?.page ?? page,
    pageSize: body?.meta?.pageSize ?? pageSize,
  };
}

export async function fetchWebhookEndpoint(endpointId: string): Promise<WebhookEndpointView> {
  const body = unwrap(
    await dashboardFetch<{ data?: { endpoint?: WebhookEndpointView } }>(
      `${BASE}/${encodeURIComponent(endpointId)}`
    )
  );
  return requireField(body?.data?.endpoint);
}

export async function fetchWebhookDeliveries(
  endpointId: string,
  page: number,
  pageSize: number
): Promise<WebhookDeliveriesPage> {
  const body = unwrap(
    await dashboardFetch<{
      data?: WebhookDeliveryView[];
      meta?: { total?: number; page?: number; pageSize?: number };
    }>(`${BASE}/${encodeURIComponent(endpointId)}/deliveries?page=${page}&pageSize=${pageSize}`)
  );
  return {
    deliveries: body?.data ?? [],
    total: body?.meta?.total ?? 0,
    page: body?.meta?.page ?? page,
    pageSize: body?.meta?.pageSize ?? pageSize,
  };
}

export async function createWebhookEndpoint(input: {
  url: string;
  label: string;
  description?: string;
}): Promise<CreateWebhookEndpointResult> {
  const body = unwrap(
    await dashboardFetch<{ data?: { endpoint?: WebhookEndpointView; secret?: string } }>(BASE, {
      method: "POST",
      body: input,
    })
  );
  return {
    endpoint: requireField(body?.data?.endpoint),
    secret: requireField(body?.data?.secret),
  };
}

export async function updateWebhookEndpoint(
  endpointId: string,
  input: { label?: string; description?: string | null; status?: WebhookEndpointStatus }
): Promise<WebhookEndpointView> {
  const body = unwrap(
    await dashboardFetch<{ data?: { endpoint?: WebhookEndpointView } }>(
      `${BASE}/${encodeURIComponent(endpointId)}`,
      { method: "PATCH", body: input }
    )
  );
  return requireField(body?.data?.endpoint);
}

export async function deleteWebhookEndpoint(
  endpointId: string
): Promise<{ deleted: boolean; referencingWorkflows: number }> {
  const body = unwrap(
    await dashboardFetch<{ data?: { deleted?: boolean; referencingWorkflows?: number } }>(
      `${BASE}/${encodeURIComponent(endpointId)}`,
      { method: "DELETE" }
    )
  );
  return {
    deleted: body?.data?.deleted ?? false,
    referencingWorkflows: body?.data?.referencingWorkflows ?? 0,
  };
}

export async function rotateWebhookEndpointSecret(
  endpointId: string,
  // Explicit rather than relying on the API default, so the grace the confirm dialog
  // quotes and the grace the rotation applies can never drift apart.
  gracePeriodHours: number
): Promise<RotateWebhookSecretResult> {
  const body = unwrap(
    await dashboardFetch<{
      data?: {
        endpoint?: WebhookEndpointView;
        secret?: string;
        previousSecretExpiresAt?: string | null;
      };
    }>(`${BASE}/${encodeURIComponent(endpointId)}/rotate-secret`, {
      method: "POST",
      body: { gracePeriodHours },
    })
  );
  return {
    endpoint: requireField(body?.data?.endpoint),
    secret: requireField(body?.data?.secret),
    previousSecretExpiresAt: body?.data?.previousSecretExpiresAt ?? null,
  };
}

export async function redeliverWebhookDelivery(
  endpointId: string,
  deliveryId: string
): Promise<WebhookDeliveryView> {
  const body = unwrap(
    await dashboardFetch<{ data?: { delivery?: WebhookDeliveryView } }>(
      `${BASE}/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
      { method: "POST" }
    )
  );
  return requireField(body?.data?.delivery);
}
