import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.get",
    `/v1/counterparties/${encodeURIComponent(counterpartyId)}`
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.update",
    `/v1/counterparties/${encodeURIComponent(counterpartyId)}`
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  const { counterpartyId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.delete",
    `/v1/counterparties/${encodeURIComponent(counterpartyId)}`
  );
}
