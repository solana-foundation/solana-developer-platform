import { NextResponse } from "next/server";
import { parseErrorMessage } from "@/app/dashboard/activity-format-utils";
import { loadWalletActivity } from "@/app/dashboard/custody/wallet-activity.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

interface VisibilityResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function verifyWalletVisibility(
  request: SdpApiClient["request"],
  walletId: string
): Promise<VisibilityResult> {
  try {
    const response = await request(`/v1/wallets/${encodeURIComponent(walletId)}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: error instanceof Error ? error.message : "Unable to verify wallet visibility",
    };
  }
}

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const trace = createTimedTrace("route.dashboard.wallets.activity", request);
  let resolvedWalletId = "";

  try {
    const { walletId } = await context.params;
    try {
      resolvedWalletId = decodeURIComponent(walletId);
    } catch {
      const response = NextResponse.json(
        { error: { message: "Invalid walletId route parameter" } },
        {
          status: 400,
          headers: {
            "X-SDP-Trace-ID": trace.traceId,
            "Server-Timing": trace.serverTiming(),
          },
        }
      );
      logRouteResult(trace, 400, {
        walletId,
        error: "Invalid walletId route parameter",
      });
      return response;
    }

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.wallets.activity.api")
    );

    const visibility = await trace.step("verify_wallet_visibility", () =>
      verifyWalletVisibility(apiClient.request, resolvedWalletId)
    );
    if (!visibility.ok) {
      const status = visibility.status ?? 500;
      const response = NextResponse.json(
        { error: { message: visibility.error ?? "Wallet activity request failed" } },
        {
          status,
          headers: {
            "X-SDP-Trace-ID": trace.traceId,
            "Server-Timing": trace.serverTiming(),
          },
        }
      );
      logRouteResult(trace, status, {
        walletId: resolvedWalletId,
        activityRowCount: 0,
        error: visibility.error ?? "Wallet activity request failed",
      });
      return response;
    }

    const result = await trace.step("load_wallet_activity", () =>
      loadWalletActivity(apiClient.request, resolvedWalletId)
    );
    const status = result.ok ? 200 : (result.status ?? 500);
    const response = NextResponse.json(
      result.ok
        ? {
            data: result.data ?? {
              activityRows: [],
              activityError: null,
              activityNotice: null,
            },
          }
        : { error: { message: result.error ?? "Wallet activity request failed" } },
      {
        status,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, status, {
      walletId: resolvedWalletId,
      activityRowCount: result.data?.activityRows?.length ?? 0,
      error: result.ok ? null : (result.error ?? "Wallet activity request failed"),
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Wallet activity request failed",
        },
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
      walletId: resolvedWalletId || "unknown",
      error: error instanceof Error ? error.message : "Wallet activity request failed",
    });
    return response;
  }
}
