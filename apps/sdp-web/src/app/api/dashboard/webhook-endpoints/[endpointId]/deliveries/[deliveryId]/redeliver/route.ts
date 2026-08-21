import { proxyWebhooks } from "@/lib/webhooks-proxy";

// POST manual redelivery of a logged delivery (creates a new delivery row).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ endpointId: string; deliveryId: string }> }
) {
  const { endpointId, deliveryId } = await params;
  return proxyWebhooks(
    request,
    `/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
    { method: "POST", traceName: "route.dashboard.webhook-endpoints.redeliver" }
  );
}
