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
  const cursor = incoming.searchParams.get("cursor");
  const viewerCanDecide = incoming.searchParams.get("viewerCanDecide");

  if (status && APPROVAL_STATUSES.has(status)) query.set("status", status);
  if (limit && /^\d{1,3}$/.test(limit)) query.set("limit", limit);
  // An opaque cursor from a previous page's `nextCursor`; the API rejects a malformed one.
  if (cursor && /^[A-Za-z0-9_-]{1,512}$/.test(cursor)) query.set("cursor", cursor);
  if (viewerCanDecide === "true" || viewerCanDecide === "false") {
    query.set("viewerCanDecide", viewerCanDecide);
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.approval-requests.list",
    path: `/v1/wallets/approval-requests${query.size > 0 ? `?${query}` : ""}`,
  });
}
