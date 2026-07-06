import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.get",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}`,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.update",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}`,
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.delete",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}`,
  });
}
