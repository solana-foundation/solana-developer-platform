import type { FrozenAccount, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";
import { NextResponse } from "next/server";
import { fetchPaymentsWallets } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

interface PaginatedMeta {
  total?: number;
  hasMore?: boolean;
}

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

async function fetchList<T>(
  request: Awaited<ReturnType<typeof createSdpApiClient>>["request"],
  path: string
): Promise<{
  status: number | null;
  data: T[];
  error: string | null;
  total: number | null;
  hasMore: boolean;
}> {
  try {
    const response = await request(path);
    if (!response.ok) {
      const body = await response.text();
      return {
        status: response.status,
        data: [],
        error: parseErrorMessage(body),
        total: null,
        hasMore: false,
      };
    }

    const payload = (await response.json()) as {
      data?: T[];
      meta?: PaginatedMeta;
    };

    return {
      status: response.status,
      data: Array.isArray(payload.data) ? payload.data : [],
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : null,
      hasMore: payload.meta?.hasMore === true,
    };
  } catch (error) {
    return {
      status: null,
      data: [],
      error: error instanceof Error ? error.message : "Request failed",
      total: null,
      hasMore: false,
    };
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.supporting_data", request);

  try {
    const { tokenId } = await params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.supporting_data.api")
    );

    const [walletsResult, transactionsResult, allowlistResult, frozenResult] = await Promise.all([
      trace.step("fetch_authority_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary", includeBalances: false })
      ),
      trace.step("fetch_transactions", () =>
        fetchList<TokenTransaction>(
          apiClient.request,
          `/v1/issuance/tokens/${tokenId}/transactions?page=1&pageSize=100`
        )
      ),
      trace.step("fetch_allowlist", () =>
        fetchList<TokenAllowlistEntry>(
          apiClient.request,
          `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=100`
        )
      ),
      trace.step("fetch_frozen_accounts", () =>
        fetchList<FrozenAccount>(
          apiClient.request,
          `/v1/issuance/tokens/${tokenId}/frozen?page=1&pageSize=100`
        )
      ),
    ]);

    const response = NextResponse.json(
      {
        data: {
          authorityWallets: walletsResult.data ?? [],
          authorityWalletsError: walletsResult.ok
            ? null
            : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`,
          transactions: transactionsResult.data,
          transactionsError: transactionsResult.error
            ? `Transactions API ${transactionsResult.status ?? "unavailable"}: ${transactionsResult.error}`
            : null,
          transactionsTotal: transactionsResult.total,
          transactionsHasMore: transactionsResult.hasMore,
          allowlistEntries: allowlistResult.data,
          allowlistError: allowlistResult.error
            ? `Allowlist API ${allowlistResult.status ?? "unavailable"}: ${allowlistResult.error}`
            : null,
          allowlistTotal: allowlistResult.total,
          allowlistHasMore: allowlistResult.hasMore,
          frozenAccounts: frozenResult.data,
          frozenAccountsError: frozenResult.error
            ? `Frozen API ${frozenResult.status ?? "unavailable"}: ${frozenResult.error}`
            : null,
          frozenAccountsTotal: frozenResult.total,
          frozenAccountsHasMore: frozenResult.hasMore,
        },
      },
      {
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, 200, {
      tokenId,
      transactionCount: transactionsResult.data.length,
      allowlistCount: allowlistResult.data.length,
      frozenCount: frozenResult.data.length,
      authorityWalletCount: walletsResult.data?.length ?? 0,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load token supporting data",
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to load token supporting data",
    });

    return response;
  }
}
