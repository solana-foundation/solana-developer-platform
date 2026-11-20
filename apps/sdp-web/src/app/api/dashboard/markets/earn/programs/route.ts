import { programProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.list",
    path: `/v1/earn/portfolio-accounts${programProxyQuery(request, { provider: true, page: true })}`,
  });
}

/**
 * Explicit create (PRO-1670). The API requires exactly one of a body
 * `requestId` or an `Idempotency-Key` header — this legacy program client
 * sends the body form. Since HOO-1918 the proxy relays an inbound
 * `Idempotency-Key` on every mutation (and the browser's fetch layer mints one
 * for any mutation without one), so a dashboard caller of this route must send
 * a body WITHOUT `requestId` — sdp-api refuses a request carrying both key
 * sources. There is no dashboard caller today; the route remains for the
 * documented API surface.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.create",
    path: "/v1/earn/portfolio-accounts",
  });
}
