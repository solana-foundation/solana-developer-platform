import { proxyToSdpApi } from "@/lib/sdp-api";
import { proxyQueryErrorResponse, vaultWithdrawalsProxyQuery } from "../provider-query";

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
  const validated = vaultWithdrawalsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawals.list",
    path: `/v1/earn/vault-withdrawals${validated.query}`,
  });
}
