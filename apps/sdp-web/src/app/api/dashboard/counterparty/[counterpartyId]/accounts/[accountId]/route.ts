import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string; accountId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { counterpartyId, accountId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.accounts.update",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts/${encodeURIComponent(accountId)}`,
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { counterpartyId, accountId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.accounts.delete",
    path: `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts/${encodeURIComponent(accountId)}`,
  });
}
