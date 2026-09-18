import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

/** Recover escrowed shares after the request deadline; never a money-in gate. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ withdrawalRequestId: string }> }
) {
  const { withdrawalRequestId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.cancel",
    path: `/v1/earn/vault-withdrawal-requests/${encodeURIComponent(withdrawalRequestId)}/cancel`,
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}
