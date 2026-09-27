import { proxyToSdpApi, readProjectContextId } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const query = new URLSearchParams(new URL(request.url).searchParams);

  if (!query.has("includeAllProviders")) {
    query.set("includeAllProviders", "true");
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets",
    path: `/v1/wallets?${query.toString()}`,
    // A surface that presents a rendered project context (e.g. the token
    // detail's signer inventory, compared against that token's authorities)
    // gets the wallets of exactly that project (SOLA9-564); requests without a
    // context keep the cookie-based resolution.
    boundProjectId: readProjectContextId(request),
  });
}
