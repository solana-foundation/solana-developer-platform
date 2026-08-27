import { NextResponse } from "next/server";
import { z } from "zod";
import { parseErrorMessage } from "@/app/dashboard/activity-format-utils";
import {
  loadWalletActivity,
  type WalletActivityIdentity,
} from "@/app/dashboard/custody/wallet-activity.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getTranslations } from "@/i18n/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";

interface VisibilityResult {
  ok: boolean;
  status?: number;
  error?: string;
  wallet?: WalletActivityIdentity;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

const walletActivityMetadataEnvelopeSchema = z.object({
  data: z.object({
    wallet: z.object({
      id: z.string().trim().min(1),
      walletId: z.string().trim().min(1),
    }),
  }),
});

async function verifyWalletVisibility(
  request: SdpApiClient["request"],
  walletId: string,
  t: Translate
): Promise<VisibilityResult> {
  try {
    const response = await request(getWalletMetadataPath(walletId));
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const parsed = walletActivityMetadataEnvelopeSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) {
      return { ok: false, status: 502, error: t("DashboardCustody.walletActivityRequestFailed") };
    }

    const wallet = parsed.data.data.wallet;

    return {
      ok: true,
      wallet: { custodyWalletId: wallet.id, providerWalletId: wallet.walletId },
    };
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
    if (!visibility.ok || !visibility.wallet) {
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

    const wallet = visibility.wallet;
    const result = await trace.step("load_wallet_activity", () =>
      loadWalletActivity(apiClient.request, wallet, t)
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
