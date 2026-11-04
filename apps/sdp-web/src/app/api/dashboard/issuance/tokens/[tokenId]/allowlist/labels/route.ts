import { parseErrorMessage } from "@/lib/api-error";
import { dashboardJson } from "@/lib/dashboard-response";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.allowlist_labels", request);

  try {
    const { tokenId } = await params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.allowlist_labels.api")
    );

    const response = await apiClient.request(
      `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/allowlist/labels`
    );

    if (!response.ok) {
      const body = await response.text();
      return dashboardJson(
        {
          labels: [],
          total: 0,
          error: `Allowlist labels API ${response.status}: ${parseErrorMessage(body)}`,
        },
        { status: response.status }
      );
    }

    const payload = (await response.json()) as {
      data?: { labels?: string[]; total?: number };
    };

    return dashboardJson({
      labels: Array.isArray(payload.data?.labels) ? payload.data.labels : [],
      total: typeof payload.data?.total === "number" ? payload.data.total : 0,
      error: null,
    });
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    });
    return dashboardJson({ labels: [], total: 0, error: "Request failed" }, { status: 500 });
  }
}
