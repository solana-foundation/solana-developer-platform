import { proxyWebhooks } from "@/lib/webhooks-proxy";

// GET endpoint detail · PATCH label/description/status · DELETE (soft delete)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  return proxyWebhooks(request, `/${encodeURIComponent(endpointId)}`, {
    traceName: "route.dashboard.webhook-endpoints.get",
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyWebhooks(request, `/${encodeURIComponent(endpointId)}`, {
    method: "PATCH",
    body,
    traceName: "route.dashboard.webhook-endpoints.update",
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  return proxyWebhooks(request, `/${encodeURIComponent(endpointId)}`, {
    method: "DELETE",
    traceName: "route.dashboard.webhook-endpoints.delete",
  });
}
