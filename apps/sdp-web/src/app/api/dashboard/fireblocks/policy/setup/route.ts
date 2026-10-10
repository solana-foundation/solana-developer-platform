import { proxyToSdpApi } from "@/lib/sdp-api";
export async function GET(request: Request) {
  const query = new URL(request.url).search;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.fireblocks.policy.setup",
    path: `/internal/dashboard/fireblocks/policy/setup${query}`,
  });
}
