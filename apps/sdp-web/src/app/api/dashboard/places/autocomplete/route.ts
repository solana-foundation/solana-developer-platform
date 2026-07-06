import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(request, "route.dashboard.places.autocomplete", "/v1/places/autocomplete");
}
