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

const ALLOWED_PAGE_SIZE = 200;

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.audit", request);

  try {
    const { tokenId } = await params;
    const requestUrl = new URL(request.url);
    const action = requestUrl.searchParams.get("action")?.trim();
    const status = requestUrl.searchParams.get("status")?.trim();
    const type = requestUrl.searchParams.get("type")?.trim();
    const pageSizeRaw = Number.parseInt(requestUrl.searchParams.get("pageSize") ?? "50", 10);
    const pageSize = Number.isInteger(pageSizeRaw)
      ? Math.min(Math.max(pageSizeRaw, 1), ALLOWED_PAGE_SIZE)
      : 50;

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.audit.api")
    );

    const query = new URLSearchParams({ page: "1", pageSize: String(pageSize) });
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
