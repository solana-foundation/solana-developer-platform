import { NextResponse } from "next/server";
import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ direction: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { direction } = await context.params;
  if (direction !== "onramp" && direction !== "offramp") {
    return NextResponse.json(
      {
        error: {
          message: "Unsupported ramp quote direction",
        },
      },
      { status: 400 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.ramps.quote.post",
    path: `/v1/payments/ramps/${direction}/quote`,
    // A keyed quote retry must reach the upstream replay record: the wizard
    // retains one operation key per committed quote selection precisely so the
    // API replays the first outcome instead of minting a second provider
    // session and transfer row after a lost response.
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}
