import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Quote what a vault deposit would mint right now, so the deposit modal can
 * derive its `minSharesOut` floor from the provider's live rate. A read with
 * no side effects: no `upstreamHeaders`, because unlike the deposit POST this
 * route accepts no client-owned transport metadata at all.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposit_previews.create",
    path: "/v1/earn/vault-deposit-previews",
  });
}
