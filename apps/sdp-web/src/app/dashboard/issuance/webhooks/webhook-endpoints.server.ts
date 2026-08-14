import type { SdpApiClient } from "@/lib/sdp-api";
import type { WebhookEndpointView } from "./webhook-endpoints.data";

// Server-component fetcher for the detail page's initial paint (client refresh goes
// through the BFF in webhook-endpoints.client.ts).
export async function fetchWebhookEndpointServer(
  apiClient: SdpApiClient,
  endpointId: string
): Promise<WebhookEndpointView> {
  const response = await apiClient.fetch<{ endpoint: WebhookEndpointView }>(
    `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`
  );
  return response.endpoint;
}
