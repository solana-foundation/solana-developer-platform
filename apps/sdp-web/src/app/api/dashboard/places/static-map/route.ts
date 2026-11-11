import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const response = await proxyToSdpApi({
    request,
    traceSource: "route.dashboard.places.static-map",
    path: `/v1/places/static-map${new URL(request.url).search}`,
  });
  // The one dashboard response a browser may keep: the image is a function of the
  // coordinates in the URL alone, never of the Project, and `private` still keeps
  // shared caches out. Errors stay uncacheable like every other dashboard response.
  response.headers.set(
    "Cache-Control",
    response.ok ? "private, max-age=3600" : "private, no-store"
  );
  return response;
}
