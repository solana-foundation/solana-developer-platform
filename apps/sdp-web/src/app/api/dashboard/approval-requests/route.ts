import { proxyToSdpApi } from "@/lib/sdp-api";

const APPROVAL_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "canceled",
  "expired",
  "failed",
]);

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  const status = incoming.searchParams.get("status");
  const limit = incoming.searchParams.get("limit");

  if (status && APPROVAL_STATUSES.has(status)) query.set("status", status);
  if (limit && /^\d{1,3}$/.test(limit)) query.set("limit", limit);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.approval-requests.list",
    path: `/v1/wallets/approval-requests${query.size > 0 ? `?${query}` : ""}`,
  });
}
