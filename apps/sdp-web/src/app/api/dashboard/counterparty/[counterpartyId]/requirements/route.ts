import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.requirements",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}/requirements${new URL(request.url).search}`,
  });
}

export async function POST(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.requirements.submit",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}/requirements`,
  });
}
