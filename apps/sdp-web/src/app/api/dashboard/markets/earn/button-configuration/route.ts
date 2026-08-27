import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { proxyToSdpApi } from "@/lib/sdp-api";

const API_PATH = "/v1/earn/button-configurations/current";

// PUT only. The builder loads the saved configuration server-side through
// createSdpApiClient(), so a GET proxy here had no caller — and, lacking the
// expectedProjectId guard below, would hand a future adopter the
// stale-project-cookie hazard this route was guarded against.
export async function PUT(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.button_configuration.upsert",
    path: API_PATH,
    expectedProjectId: request.headers.get(PROJECT_HEADER_NAME) ?? "",
  });
}
