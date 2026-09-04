import { proxyWebhooks } from "@/lib/webhooks-proxy";

// POST rotate signing secret (response carries the new secret ONCE).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyWebhooks(request, `/${encodeURIComponent(endpointId)}/rotate-secret`, {
    method: "POST",
    body,
    traceName: "route.dashboard.webhook-endpoints.rotate-secret",
  });
}
