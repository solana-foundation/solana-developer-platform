import { NextResponse } from "next/server";
import { parseErrorMessage } from "@/app/dashboard/activity-format-utils";
import { loadWalletActivity } from "@/app/dashboard/custody/wallet-activity.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getTranslations } from "@/i18n/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

interface VisibilityResult {
  ok: boolean;
  status?: number;
  error?: string;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

async function verifyWalletVisibility(
  request: SdpApiClient["request"],
  walletId: string,
  t: Translate
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
      error:
        error instanceof Error
          ? error.message
          : t("DashboardCustody.unableToVerifyWalletVisibility"),
    };
  }
}

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const trace = createTimedTrace("route.dashboard.wallets.activity", request);
  const t = await getTranslations();
  let resolvedWalletId = "";

  try {
    const { walletId } = await context.params;
    try {
      resolvedWalletId = decodeURIComponent(walletId);
    } catch {
      const response = NextResponse.json(
        { error: { message: t("DashboardCustody.invalidWalletId") } },
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
        error: t("DashboardCustody.invalidWalletId"),
      });
      return response;
    }

    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.wallets.activity.api")
    );

    const visibility = await trace.step("verify_wallet_visibility", () =>
      verifyWalletVisibility(apiClient.request, resolvedWalletId, t)
    );
    if (!visibility.ok) {
      const status = visibility.status ?? 500;
      const response = NextResponse.json(
        {
          error: { message: visibility.error ?? t("DashboardCustody.walletActivityRequestFailed") },
        },
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
        error: visibility.error ?? t("DashboardCustody.walletActivityRequestFailed"),
      });
      return response;
    }

    const result = await trace.step("load_wallet_activity", () =>
      loadWalletActivity(apiClient.request, resolvedWalletId, t)
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
        : {
            error: {
              message: result.error ?? t("DashboardCustody.walletActivityRequestFailed"),
            },
          },
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
      error: result.ok ? null : (result.error ?? t("DashboardCustody.walletActivityRequestFailed")),
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: {
          message:
            error instanceof Error
              ? error.message
              : t("DashboardCustody.walletActivityRequestFailed"),
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
      error:
        error instanceof Error ? error.message : t("DashboardCustody.walletActivityRequestFailed"),
    });
    return response;
  }
}
