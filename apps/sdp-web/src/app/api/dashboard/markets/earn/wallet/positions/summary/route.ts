import { dashboardJson } from "@/lib/dashboard-response";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.size > 0) {
    return dashboardJson(
      { error: { message: "Wallet position summary does not accept query parameters" } },
      { status: 400 }
    );
  }

  // The dashboard is the one surface that legitimately renders per-customer
  // detail, so it is the one caller that opts in to owner addresses. The API
  // omits them by default (PRO-1908, threat model EARN-028) and refuses
  // `includePositions` without the explicit opt-in.
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.wallet_positions.summary",
    path: "/v1/earn/external-wallet/positions/summary?includeOwnerAddresses=true&includePositions=true",
  });
}
