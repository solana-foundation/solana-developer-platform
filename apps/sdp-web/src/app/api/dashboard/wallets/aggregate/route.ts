import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const query = new URLSearchParams(new URL(request.url).searchParams);

  if (!query.has("includeAllProviders")) {
    query.set("includeAllProviders", "true");
  }

  return proxyToSdpApi(
    request,
    "route.dashboard.wallets.aggregate",
    `/v1/wallets/aggregate?${query.toString()}`
  );
}
