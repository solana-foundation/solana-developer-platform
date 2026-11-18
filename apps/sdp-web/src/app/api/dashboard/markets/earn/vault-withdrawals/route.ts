import {
  proxyQueryErrorResponse,
  vaultWithdrawalsProxyQuery,
} from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

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
