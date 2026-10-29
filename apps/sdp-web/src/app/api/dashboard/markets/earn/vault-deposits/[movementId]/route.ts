import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * One recorded vault deposit, so the dashboard can poll a signed deposit to its
 * terminal state. A GET, so the proxy forwards it no client-owned transport
 * metadata — the caller's `Idempotency-Key` travels on mutations only
 * (HOO-1918, in `proxyToSdpApi`).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ movementId: string }> }
) {
  const { movementId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_deposits.get",
    path: `/v1/earn/vault-deposits/${encodeURIComponent(movementId)}`,
  });
}
