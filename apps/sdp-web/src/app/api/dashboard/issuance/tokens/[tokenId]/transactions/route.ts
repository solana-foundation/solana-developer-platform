import type { TokenTransaction } from "@sdp/types";
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

// Matches the API's server-side pageSize cap for the per-token transactions
// handler. The dashboard grows a single page-1 window up to this ceiling, so
// this is the most rows it can ever return.
const ALLOWED_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.transactions", request);

  try {
    const { tokenId } = await params;
    const requestUrl = new URL(request.url);
    const type = requestUrl.searchParams.get("type")?.trim();
    const status = requestUrl.searchParams.get("status")?.trim();
    const pageSizeRaw = Number.parseInt(
      requestUrl.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE),
      10
    );
    const pageSize = Number.isInteger(pageSizeRaw)
      ? Math.min(Math.max(pageSizeRaw, 1), ALLOWED_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.transactions.api")
    );

    const query = new URLSearchParams({ page: "1", pageSize: String(pageSize) });
    if (type) {
      query.set("type", type);
    }
    if (status) {
      query.set("status", status);
    }

    const response = await apiClient.request(
      `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/transactions?${query.toString()}`
    );

    if (!response.ok) {
      const body = await response.text();
      return NextResponse.json(
        {
          data: [],
          error: `Transactions API ${response.status}: ${parseErrorMessage(body)}`,
          total: 0,
          hasMore: false,
        },
        { status: response.status }
      );
    }

    const payload = (await response.json()) as {
      data?: TokenTransaction[];
      meta?: { total?: number; hasMore?: boolean };
    };

    return NextResponse.json({
      data: Array.isArray(payload.data) ? payload.data : [],
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : 0,
      // Force hasMore off once the window hits the cap. Growing pageSize beyond it
      // just clamps back to the same page-1 window, so the API's hasMore (total >
      // window) would otherwise keep "Load more" visible forever without ever
      // returning new rows.
      hasMore: payload.meta?.hasMore === true && pageSize < ALLOWED_PAGE_SIZE,
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
