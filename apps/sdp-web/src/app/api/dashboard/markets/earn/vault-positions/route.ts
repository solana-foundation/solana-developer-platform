import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";
import { vaultPositionsProxyQuery } from "../provider-query";

export async function GET(request: Request) {
  const validated = vaultPositionsProxyQuery(request);
  if (!validated.ok) {
    return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_positions.list",
    path: `/v1/earn/vault-positions${validated.query}`,
  });
}
