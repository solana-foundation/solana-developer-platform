import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * One recorded vault deposit, so the dashboard can poll a signed deposit to its
 * terminal state. No `upstreamHeaders`: unlike the create next door, this read
 * accepts no client-owned transport metadata at all.
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
