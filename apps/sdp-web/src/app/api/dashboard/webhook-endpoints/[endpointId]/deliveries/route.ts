import { paginationQuery, proxyWebhooks } from "@/lib/webhooks-proxy";

// GET per-attempt delivery log for an endpoint, newest first.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  return proxyWebhooks(
    request,
    `/${encodeURIComponent(endpointId)}/deliveries${paginationQuery(request)}`,
    { traceName: "route.dashboard.webhook-endpoints.deliveries" }
  );
}
