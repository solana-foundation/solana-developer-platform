import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * One recorded withdrawal, so the dashboard can poll a signed exit to its
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
    traceSource: "route.dashboard.earn.vault_withdrawals.get",
    path: `/v1/earn/vault-withdrawals/${encodeURIComponent(movementId)}`,
  });
}
