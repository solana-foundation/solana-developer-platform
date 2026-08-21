import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";
import { earnMovementsProxyQuery } from "../provider-query";

export async function GET(request: Request) {
  const validated = earnMovementsProxyQuery(request);
  if (!validated.ok) {
    return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.movements.list",
    path: `/v1/earn/movements${validated.query}`,
  });
}
