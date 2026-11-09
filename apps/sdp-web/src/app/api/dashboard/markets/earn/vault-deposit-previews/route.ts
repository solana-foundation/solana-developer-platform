import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Quote what a vault deposit would mint right now, so the deposit modal can
 * derive its `minSharesOut` floor from the provider's live rate. A read with
 * no side effects. The route supplies no `upstreamHeaders` of its own; the
 * proxy still relays an inbound `Idempotency-Key` on this POST (HOO-1918),
 * the one piece of client-owned transport metadata it forwards.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposit_previews.create",
    path: "/v1/earn/vault-deposit-previews",
  });
}
