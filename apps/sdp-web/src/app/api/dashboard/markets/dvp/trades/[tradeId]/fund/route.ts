import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Funds one side. The Idempotency-Key is forwarded so a retry after a dropped
 * connection returns the first request's transfer instead of sending another.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.fund",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/fund`,
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}
