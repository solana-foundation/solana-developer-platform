import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ placeId: string }> }) {
  const { placeId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.places.get",
    `/v1/places/${encodeURIComponent(placeId)}${new URL(request.url).search}`
  );
}
