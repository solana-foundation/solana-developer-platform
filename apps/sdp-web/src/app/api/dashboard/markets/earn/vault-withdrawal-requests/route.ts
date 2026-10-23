import { vaultWithdrawalRequestsProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyValidatedGet } from "@/app/api/dashboard/markets/proxy-read";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.create",
    path: "/v1/earn/vault-withdrawal-requests",
  });
}

export async function GET(request: Request) {
  return proxyValidatedGet(request, {
    validate: vaultWithdrawalRequestsProxyQuery,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.list",
    path: (query) => `/v1/earn/vault-withdrawal-requests${query}`,
  });
}
