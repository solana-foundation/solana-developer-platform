import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const query = new URLSearchParams(new URL(request.url).searchParams);

  if (!query.has("includeAllProviders")) {
    query.set("includeAllProviders", "true");
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets",
    path: `/v1/wallets?${query.toString()}`,
  });
}
