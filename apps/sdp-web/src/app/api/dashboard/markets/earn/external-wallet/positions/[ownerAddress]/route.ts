import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";
import { externalWalletPositionsProxyQuery } from "../../../provider-query";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ownerAddress: string }> }
) {
  const validated = externalWalletPositionsProxyQuery(request);
  if (!validated.ok) {
    return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
  }

  const { ownerAddress } = await params;
  // The API addresses the owner as a required query filter (the shape every
  // per-owner external-wallet read shares); this route keeps its dashboard
  // path-param shape and translates.
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.external_wallet_positions.list",
    path: `/v1/earn/external-wallet/positions?ownerAddress=${encodeURIComponent(ownerAddress)}${validated.query.replace(/^\?/, "&")}`,
  });
}
