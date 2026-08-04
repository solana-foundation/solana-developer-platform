import type { AssetAuditEvent } from "@sdp/types";
import { NextResponse } from "next/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body || "Unknown error";
  }
}

// Matches the API's server-side pageSize cap (the parsePositiveInteger max in
// the issuance audit handler). The dashboard pages with a fixed size under this;
// the clamp is just a defensive bound on the incoming param.
const MAX_PAGE_SIZE = 100;

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.audit", request);

  try {
    const { tokenId } = await params;
    const requestUrl = new URL(request.url);
    const action = requestUrl.searchParams.get("action")?.trim();
    const status = requestUrl.searchParams.get("status")?.trim();
    const type = requestUrl.searchParams.get("type")?.trim();
    const pageRaw = Number.parseInt(requestUrl.searchParams.get("page") ?? "1", 10);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSizeRaw = Number.parseInt(requestUrl.searchParams.get("pageSize") ?? "50", 10);
    const pageSize = Number.isInteger(pageSizeRaw)
      ? Math.min(Math.max(pageSizeRaw, 1), MAX_PAGE_SIZE)
      : 50;

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.audit.api")
    );

    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (action) {
      query.set("action", action);
    }
    if (status) {
      query.set("status", status);
    }
    if (type) {
      query.set("type", type);
    }

    const response = await apiClient.request(
      `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/audit?${query.toString()}`
    );

    if (!response.ok) {
      const body = await response.text();
      return NextResponse.json(
        {
          data: [],
          error: `Audit API ${response.status}: ${parseErrorMessage(body)}`,
          total: 0,
          hasMore: false,
        },
        { status: response.status }
      );
    }

    const payload = (await response.json()) as {
      data?: AssetAuditEvent[];
      meta?: { total?: number; hasMore?: boolean };
    };

    return NextResponse.json({
      data: Array.isArray(payload.data) ? payload.data : [],
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : 0,
      hasMore: payload.meta?.hasMore === true,
      page,
      pageSize,
    });
  } catch (error) {
    return NextResponse.json(
      {
        data: [],
        error: error instanceof Error ? error.message : "Request failed",
        total: 0,
        hasMore: false,
      },
      { status: 500 }
    );
  }
}
