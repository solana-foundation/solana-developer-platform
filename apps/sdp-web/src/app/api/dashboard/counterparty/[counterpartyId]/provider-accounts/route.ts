import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.provider_accounts.list",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}/provider-accounts${new URL(request.url).search}`,
  });
}
