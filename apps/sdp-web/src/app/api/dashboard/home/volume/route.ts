import { NextResponse } from "next/server";
import { computeTodaysVolume } from "@/app/dashboard/home-page.data";
import { fetchDashboardPaymentTransfers } from "@/app/dashboard/payments/payments-page.data";
import { getTranslations } from "@/i18n/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

/**
 * Today's volume, apart from the activity list.
 *
 * The list gives each wallet a deadline so one slow wallet cannot hold it back,
 * and a list missing a wallet can say so. A total cannot: a sum over some
 * wallets is a smaller number, not the volume. So this read waits on every
 * wallet, and Home shows the figure when it lands without holding the list.
 */
export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.home.volume", request);
  const t = await getTranslations();

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.home.volume.api")
    );
    const transfersResult = await trace.step("fetch_payment_transfers", () =>
      fetchDashboardPaymentTransfers(apiClient.request, 20)
    );
    // Without a deadline only a failed read leaves a wallet out, and then the
    // sum would still understate the day.
    const complete =
      transfersResult.ok && transfersResult.walletsNotLoaded === 0 && transfersResult.data;

    const response = NextResponse.json(
      {
        data: {
          todaysVolume: complete ? computeTodaysVolume(complete) : null,
          todaysVolumeError: complete
            ? null
            : t("Shared.homeWorkspace.paymentsActivityUnavailable"),
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
      walletsNotLoaded: transfersResult.walletsNotLoaded,
    });
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : t("Shared.homeWorkspace.failedToLoadActivity");
    const response = NextResponse.json(
      { error: message },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );
    logRouteResult(trace, 500, { error: message });
    return response;
  }
}
