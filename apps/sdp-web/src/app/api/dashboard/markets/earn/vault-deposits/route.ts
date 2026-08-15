import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Deposit into a NON-CUSTODIAL vault from an SDP custody wallet.
 *
 * Separate from `programs/route.ts` because the two model different money:
 * creating a program provisions a provider wallet the customer funds later,
 * while this call moves money now — SDP builds the instruction, signs it with
 * the chosen custody wallet, and submits it.
 *
 * The API requires a body `requestId` (UUIDv4) and refuses a request without
 * one. `proxyToSdpApi` forwards `{ method, body }` and builds its own headers,
 * so an inbound `Idempotency-Key` never reaches the API — the body form is the
 * only one that can, exactly as on the programs create route.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vaultDeposits.create",
    path: "/v1/earn/vault-deposits",
  });
}
