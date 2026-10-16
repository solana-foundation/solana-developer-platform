import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  const incoming = new URL(request.url).searchParams;
  const minimumSlot = incoming.get("minimumSlot");
  if (
    minimumSlot !== null &&
    (incoming.getAll("minimumSlot").length !== 1 ||
      !/^(0|[1-9]\d*)$/.test(minimumSlot) ||
      !Number.isSafeInteger(Number(minimumSlot)))
  ) {
    return Response.json(
      { error: { message: "Invalid wallet balance minimumSlot" } },
      { status: 400 }
    );
  }
  const query = minimumSlot === null ? "" : `?minimumSlot=${minimumSlot}`;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.wallets.balances.get",
    path: `/v1/payments/wallets/${encodeURIComponent(walletId)}/balances${query}`,
  });
}
