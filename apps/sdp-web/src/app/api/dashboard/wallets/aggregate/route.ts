import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const query = new URLSearchParams(new URL(request.url).searchParams);

  // A workspace that names its rendered project pins the upstream read to it,
  // validated against the authenticated organization, instead of the mutable
  // shared selection cookie a sibling tab can move (SOLA9-618). The parameter
  // is dashboard-owned and never forwarded upstream.
  const requestedProjectId = query.get("projectId");
  query.delete("projectId");

  if (!query.has("includeAllProviders")) {
    query.set("includeAllProviders", "true");
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets.aggregate",
    path: `/v1/wallets/aggregate?${query.toString()}`,
    explicitProjectId: requestedProjectId ?? undefined,
  });
}
