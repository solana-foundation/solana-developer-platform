import {
  proxyQueryErrorResponse,
  vaultWithdrawalsProxyQuery,
} from "@/app/api/dashboard/markets/earn/provider-query";
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
 * is still in flight after a reload. The read supplies no `upstreamHeaders` and
 * forwards no client-owned transport metadata: the proxy relays an inbound
 * `Idempotency-Key` on the POST above, a mutation — never on a GET.
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
