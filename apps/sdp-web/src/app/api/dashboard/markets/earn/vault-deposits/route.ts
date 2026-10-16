import { proxyToSdpApi } from "@/lib/sdp-api";
import { proxyQueryErrorResponse, vaultDepositsProxyQuery } from "../provider-query";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposits.create",
    path: "/v1/earn/vault-deposits",
  });
}

/**
 * This workspace's recorded deposits, so the dashboard can re-derive what is
 * still in flight after a reload. No `upstreamHeaders`: unlike the POST above,
 * this read accepts no client-owned transport metadata.
 */
export async function GET(request: Request) {
  const validated = vaultDepositsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposits.list",
    path: `/v1/earn/vault-deposits${validated.query}`,
  });
}
