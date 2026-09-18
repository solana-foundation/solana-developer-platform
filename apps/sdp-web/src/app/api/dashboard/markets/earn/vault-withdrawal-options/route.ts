import { proxyToSdpApi } from "@/lib/sdp-api";

/** Resolve instant and queued exits independently for one owned position. */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_options.create",
    path: "/v1/earn/vault-withdrawal-options",
  });
}
