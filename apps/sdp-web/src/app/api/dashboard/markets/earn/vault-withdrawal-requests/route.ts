import {
  proxyQueryErrorResponse,
  vaultWithdrawalRequestsProxyQuery,
} from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.create",
    path: "/v1/earn/vault-withdrawal-requests",
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
