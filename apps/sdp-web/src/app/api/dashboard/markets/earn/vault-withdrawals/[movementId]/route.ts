import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * One recorded withdrawal, so the dashboard can poll a signed exit to its
 * terminal state. The read supplies no `upstreamHeaders` and forwards no
 * client-owned transport metadata: the proxy relays an inbound
 * `Idempotency-Key` on the create next door, a mutation — never on a GET.
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
