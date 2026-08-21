import { NextResponse } from "next/server";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";
import { vaultWithdrawalsProxyQuery } from "../provider-query";

export async function POST(request: Request) {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawals.create",
    path: "/v1/earn/vault-withdrawals",
    // Do not pass the inbound header bag. This value is the only client-owned
    // transport metadata the endpoint accepts; proxyToSdpApi owns every other
    // upstream header.
    upstreamHeaders: idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : undefined,
  });
}

/**
 * This workspace's recorded withdrawals, so the dashboard can re-derive what
 * is still in flight after a reload. No `upstreamHeaders`: unlike the
 * POST above, this read accepts no client-owned transport metadata.
 */
export async function GET(request: Request) {
  const validated = vaultWithdrawalsProxyQuery(request);
  if (!validated.ok) {
    return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawals.list",
    path: `/v1/earn/vault-withdrawals${validated.query}`,
  });
}
