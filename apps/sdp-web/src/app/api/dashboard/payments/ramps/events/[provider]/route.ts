import { RAMP_EVENT_PROVIDERS } from "@sdp/types";
import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { provider } = await context.params;
  if (!(RAMP_EVENT_PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json(
      { error: { message: "Unsupported ramp event provider" } },
      { status: 400 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.ramps.events.post",
    path: `/v1/payments/ramps/${provider}/events`,
  });
}
