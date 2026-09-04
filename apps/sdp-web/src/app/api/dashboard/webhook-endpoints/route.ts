import { paginationQuery, proxyWebhooks } from "@/lib/webhooks-proxy";

// GET list endpoints · POST create endpoint (response carries the secret ONCE)
export async function GET(request: Request) {
  return proxyWebhooks(request, paginationQuery(request), {
    traceName: "route.dashboard.webhook-endpoints.list",
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return proxyWebhooks(request, "", {
    method: "POST",
    body,
    traceName: "route.dashboard.webhook-endpoints.create",
  });
}
