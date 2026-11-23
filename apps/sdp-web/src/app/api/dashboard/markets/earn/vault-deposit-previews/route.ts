import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Quote what a vault deposit would mint right now, so the deposit modal can
 * derive its `minSharesOut` floor from the provider's live rate. A read with
 * no side effects and no `upstreamHeaders` of its own. The proxy's blanket
 * mutation rule (HOO-1918) still relays an inbound `Idempotency-Key`, which
 * this upstream read neither needs nor consults.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposit_previews.create",
    path: "/v1/earn/deposits/preview",
  });
}
