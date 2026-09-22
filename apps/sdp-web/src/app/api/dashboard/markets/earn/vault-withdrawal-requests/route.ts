import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";
import { proxyQueryErrorResponse, vaultWithdrawalRequestsProxyQuery } from "../provider-query";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.create",
    path: "/v1/earn/vault-withdrawal-requests",
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}

export async function GET(request: Request) {
  const validated = vaultWithdrawalRequestsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.list",
    path: `/v1/earn/vault-withdrawal-requests${validated.query}`,
  });
}
