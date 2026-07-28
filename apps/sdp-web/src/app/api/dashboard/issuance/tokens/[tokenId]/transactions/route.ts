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
// handler. The dashboard pages with a fixed size well under this; the clamp is
// just a defensive bound on the incoming param.
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.transactions", request);

  try {
    const { tokenId } = await params;
    const requestUrl = new URL(request.url);
    const type = requestUrl.searchParams.get("type")?.trim();
    const status = requestUrl.searchParams.get("status")?.trim();
    const pageRaw = Number.parseInt(requestUrl.searchParams.get("page") ?? "1", 10);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSizeRaw = Number.parseInt(
      requestUrl.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE),
      10
    );
    const pageSize = Number.isInteger(pageSizeRaw)
      ? Math.min(Math.max(pageSizeRaw, 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.transactions.api")
    );

    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
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
          page,
          pageSize,
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
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      },
      { status: 500 }
    );
  }
}
