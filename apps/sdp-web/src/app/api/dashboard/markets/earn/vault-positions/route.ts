import {
  proxyQueryErrorResponse,
  vaultPositionsProxyQuery,
} from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const validated = vaultPositionsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_positions.list",
    path: `/v1/earn/vault-positions${validated.query}`,
  });
}
