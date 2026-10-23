import { vaultWithdrawalsProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyValidatedGet } from "@/app/api/dashboard/markets/proxy-read";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawals.create",
    path: "/v1/earn/vault-withdrawals",
  });
}

/**
 * This workspace's recorded withdrawals, so the dashboard can re-derive what
 * is still in flight after a reload. No `upstreamHeaders`: unlike the
 * POST above, this read accepts no client-owned transport metadata.
 */
export async function GET(request: Request) {
  return proxyValidatedGet(request, {
    validate: vaultWithdrawalsProxyQuery,
    traceSource: "route.dashboard.earn.vault_withdrawals.list",
    path: (query) => `/v1/earn/vault-withdrawals${query}`,
  });
}
