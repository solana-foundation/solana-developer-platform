import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.size > 0) {
    return NextResponse.json(
      { error: { message: "External-wallet position summary does not accept query parameters" } },
      { status: 400 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.external_wallet_positions.summary",
    path: "/v1/earn/external-wallet/positions/summary",
  });
}
