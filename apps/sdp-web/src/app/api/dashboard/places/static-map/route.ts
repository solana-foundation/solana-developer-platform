import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const response = await proxyToSdpApi({
    request,
    traceSource: "route.dashboard.places.static-map",
    path: `/v1/places/static-map${new URL(request.url).search}`,
  });
  response.headers.set("Cache-Control", response.ok ? "private, max-age=3600" : "no-store");
  return response;
}
