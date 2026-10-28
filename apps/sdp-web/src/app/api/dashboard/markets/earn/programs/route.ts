import { programProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.list",
    path: `/v1/earn/programs${programProxyQuery(request, { provider: true, page: true })}`,
  });
}

/**
 * Explicit create (PRO-1670). The API requires exactly one of a body
 * `requestId` or an `Idempotency-Key` header. This legacy program contract
 * sends the body form, and the proxy relays a browser `Idempotency-Key` on
 * every mutation (HOO-1918) — so a dashboard caller here must send the header
 * form ONLY (see `createEarnWithdrawal`): beside the relayed header, the body
 * `requestId` is refused with 400 on every submit. No dashboard page calls
 * this route today.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.create",
    path: "/v1/earn/programs",
  });
}
