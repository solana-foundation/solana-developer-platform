import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Pulls one side's deposit back to the custody wallet that holds its party
 * address. The Idempotency-Key is forwarded so a retry returns the first
 * reclaim instead of draining whatever the escrow holds by then.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.reclaim",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/reclaim`,
    upstreamHeaders: idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : undefined,
  });
}
