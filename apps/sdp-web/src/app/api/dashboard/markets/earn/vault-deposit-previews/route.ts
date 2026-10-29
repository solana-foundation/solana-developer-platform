import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Quote what a vault deposit would mint right now, so the deposit modal can
 * derive its `minSharesOut` floor from the provider's live rate. No side
 * effects, and no route-selected headers: the proxy itself forwards the
 * caller's `Idempotency-Key` on a mutation like this POST (HOO-1918, in
 * `proxyToSdpApi`).
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposit_previews.create",
    path: "/v1/earn/vault-deposit-previews",
  });
}
