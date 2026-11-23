import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Quote what redeeming shares would pay right now, so the withdraw modal can
 * derive its `minAmountOut` floor from the provider's live rate. A read with
 * no side effects and no `upstreamHeaders` of its own; an inbound
 * `Idempotency-Key` is relayed by the proxy's blanket mutation rule
 * (HOO-1918) and not consulted here.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_previews.create",
    path: "/v1/earn/withdrawals/provider-signed/preview",
  });
}
