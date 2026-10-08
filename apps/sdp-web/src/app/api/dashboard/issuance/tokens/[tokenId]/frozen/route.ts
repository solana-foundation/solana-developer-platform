import type { FrozenAccount } from "@sdp/types";
import { NextResponse } from "next/server";
import { parseErrorMessage } from "@/lib/api-error";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.frozen", request);
  const { tokenId } = await params;

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.frozen.api")
    );
    const response = await apiClient.request(
      `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/frozen?page=1&pageSize=1`
    );
    if (!response.ok) {
      const body = await response.text();
      return NextResponse.json(
        {
          data: [],
          error: `Frozen accounts API ${response.status}: ${parseErrorMessage(body)}`,
          total: 0,
        },
        { status: response.status }
      );
    }

    const payload = (await response.json()) as {
      data?: FrozenAccount[];
      meta?: { total?: number };
    };
    return NextResponse.json({
      data: Array.isArray(payload.data) ? payload.data : [],
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : 0,
    });
  } catch (error) {
    return NextResponse.json(
      {
        data: [],
        error: error instanceof Error ? error.message : "Request failed",
        total: 0,
      },
      { status: 500 }
    );
  }
}
