import { NextResponse } from "next/server";
import {
  buildHomeActivityRows,
  computeTodaysVolume,
  fetchOrgIssuanceActivity,
} from "@/app/dashboard/home-page.data";
import { fetchDashboardPaymentTransfers } from "@/app/dashboard/payments/payments-page.data";
import { getTranslations } from "@/i18n/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.home.activity", request);
  const t = await getTranslations();

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.home.activity.api")
    );
    const [transfersResult, issuanceActivityResult] = await Promise.all([
      trace.step("fetch_payment_transfers", () =>
        fetchDashboardPaymentTransfers(apiClient.request, 20)
      ),
      trace.step("fetch_issuance_activity", () =>
        fetchOrgIssuanceActivity(apiClient.request, t, 20)
      ),
    ]);

    const transfersError = transfersResult.ok
      ? null
      : t("Shared.homeWorkspace.paymentsActivityUnavailable");
    const issuanceActivityError = issuanceActivityResult.ok
      ? null
      : t("Shared.homeWorkspace.issuanceActivityUnavailable");

    const activityRows = buildHomeActivityRows(
      transfersResult.data ?? [],
      issuanceActivityResult.data ?? [],
      t
    );
    const activityError =
      activityRows.length === 0 ? (transfersError ?? issuanceActivityError) : null;
    const activityNotice = [transfersError, issuanceActivityError].filter(Boolean).join(" ");

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
      issuanceTransactionCount: issuanceActivityResult.data?.length ?? 0,
      activityRowCount: activityRows.length,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t("Shared.homeWorkspace.failedToLoadActivity"),
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
      error:
        error instanceof Error ? error.message : t("Shared.homeWorkspace.failedToLoadActivity"),
    });

    return response;
  }
}
