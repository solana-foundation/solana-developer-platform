import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { proxyToSdpApi } from "@/lib/sdp-api";

const API_PATH = "/v1/earn/button-configurations/current";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.button_configuration.get",
    path: API_PATH,
  });
}

export async function PUT(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.button_configuration.upsert",
    path: API_PATH,
    expectedProjectId: request.headers.get(PROJECT_HEADER_NAME) ?? "",
  });
}
