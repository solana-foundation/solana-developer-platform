import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.compliance.address_screenings",
    "/v1/compliance/address-screenings"
  );
}
