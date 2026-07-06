import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.places.autocomplete",
    path: "/v1/places/autocomplete",
  });
}
