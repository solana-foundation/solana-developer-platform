import { NextResponse } from "next/server";
import { fetchPaymentsWallets } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.authority_wallets", request);

  try {
    const { tokenId } = await params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.authority_wallets.api")
    );

    const walletsResult = await trace.step("fetch_authority_wallets", () =>
      fetchPaymentsWallets(apiClient.request, { view: "summary" })
    );

    const response = NextResponse.json(
      {
        data: {
          authorityWallets: walletsResult.data ?? [],
          authorityWalletsError: walletsResult.ok
            ? null
            : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`,
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
      authorityWalletCount: walletsResult.data?.length ?? 0,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load authority wallets",
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
      error: error instanceof Error ? error.message : "Failed to load authority wallets",
    });

    return response;
  }
}
