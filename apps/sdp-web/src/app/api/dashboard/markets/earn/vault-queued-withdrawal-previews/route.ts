import { proxyToSdpApi } from "@/lib/sdp-api";

/** Preview the provider-owned queue terms before a request escrows shares. */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_queued_withdrawal_previews.create",
    path: "/v1/earn/vault-queued-withdrawal-previews",
  });
}
