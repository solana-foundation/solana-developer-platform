import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.accounts.list",
    `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts${new URL(request.url).search}`
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.accounts.create",
    `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts`
  );
}
