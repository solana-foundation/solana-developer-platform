import { dashboardJson } from "@/lib/dashboard-response";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  // Next hands the segment over still percent-encoded, and the path below encodes it again.
  let walletId: string;
  try {
    walletId = decodeURIComponent((await context.params).walletId);
  } catch {
    return dashboardJson({ error: { message: "Invalid wallet id" } }, { status: 400 });
  }
  const incoming = new URL(request.url).searchParams;
  const minimumSlot = incoming.get("minimumSlot");
  if (
    minimumSlot !== null &&
    (incoming.getAll("minimumSlot").length !== 1 ||
      !/^(0|[1-9]\d*)$/.test(minimumSlot) ||
      !Number.isSafeInteger(Number(minimumSlot)))
  ) {
    return dashboardJson(
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
