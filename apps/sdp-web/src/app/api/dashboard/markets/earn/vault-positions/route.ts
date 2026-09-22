import { proxyToSdpApi } from "@/lib/sdp-api";
import { proxyQueryErrorResponse, vaultPositionsProxyQuery } from "../provider-query";

export async function GET(request: Request) {
  const validated = vaultPositionsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_positions.list",
    path: `/v1/earn/vault-positions${validated.query}`,
  });
}
