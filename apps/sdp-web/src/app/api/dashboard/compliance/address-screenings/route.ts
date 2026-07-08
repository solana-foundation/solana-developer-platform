import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.compliance.address_screenings",
    path: "/v1/compliance/address-screenings",
  });
}
