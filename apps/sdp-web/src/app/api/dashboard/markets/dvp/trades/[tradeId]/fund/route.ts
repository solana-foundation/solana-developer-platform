import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Funds one side. The Idempotency-Key is forwarded so a retry after a dropped
 * connection returns the first request's transfer instead of sending another.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.fund",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/fund`,
    upstreamHeaders: idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : undefined,
  });
}
