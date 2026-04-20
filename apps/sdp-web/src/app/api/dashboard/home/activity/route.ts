import { NextResponse } from "next/server";
import {
  buildHomeActivityRows,
  computeTodaysVolume,
  fetchIssuanceTokens,
  fetchOrgIssuanceActivity,
} from "@/app/dashboard/home-page.data";
import { fetchDashboardPaymentTransfers } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.home.activity", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.home.activity.api")
    );
    const [transfersResult, issuanceTokensResult] = await Promise.all([
      trace.step("fetch_payment_transfers", () =>
        fetchDashboardPaymentTransfers(apiClient.request, 20)
      ),
      trace.step("fetch_issuance_tokens", () => fetchIssuanceTokens(apiClient.request, 20)),
    ]);

    const issuanceTokens = issuanceTokensResult.data ?? [];
    const issuanceActivityResult =
      issuanceTokensResult.ok && issuanceTokens.length > 0
        ? await trace.step("fetch_issuance_activity", () =>
            fetchOrgIssuanceActivity(apiClient.request, issuanceTokens)
          )
        : { rows: [], error: null };

    const transfersError = transfersResult.ok
      ? null
      : "Payments activity is unavailable right now.";
    const issuanceTokensError = issuanceTokensResult.ok
      ? null
      : "Issuance activity is unavailable right now.";

    const activityRows = buildHomeActivityRows(
      transfersResult.data ?? [],
      issuanceActivityResult.rows
    );
    const activityError =
      activityRows.length === 0
        ? (transfersError ?? issuanceTokensError ?? issuanceActivityResult.error)
        : null;
    const activityNotice = [transfersError, issuanceTokensError, issuanceActivityResult.error]
      .filter(Boolean)
      .join(" ");

    const response = NextResponse.json(
      {
        data: {
          todaysVolume: transfersResult.data ? computeTodaysVolume(transfersResult.data) : null,
          activityRows,
          activityError,
          activityNotice: activityNotice || null,
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
      transferCount: transfersResult.data?.length ?? 0,
      issuanceTokenCount: issuanceTokens.length,
      activityRowCount: activityRows.length,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load dashboard activity",
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
      error: error instanceof Error ? error.message : "Failed to load dashboard activity",
    });

    return response;
  }
}
