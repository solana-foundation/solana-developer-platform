"use client";

import type { OrganizationRpcProvider } from "@sdp/types";
import { Badge } from "@/components/ui/badge";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { rpcProviderLabel } from "@/lib/rpc-providers";

type Translate = ReturnType<typeof useTranslations>;

type RpcProxyResponse = {
  provider: {
    id: string;
    selectionMode: string;
    endpoint: string;
  };
  upstream: {
    ok: boolean;
    status: number;
    statusText: string;
  };
};

/**
 * Why a failed test failed. A mismatch is not an unreachable endpoint: the
 * upstream answered, another provider just owned the request. Collapsing the
 * two reported a healthy Alchemy connection as "Unreachable" beside its own
 * 200 OK.
 */
export type RpcTestFailure = "mismatch" | "upstream" | "request_failed";

export type RpcTestResult = {
  status: "success" | "error";
  reason?: RpcTestFailure;
  message: string;
  requestedProvider: OrganizationRpcProvider;
  resolvedProvider?: string;
  selectionMode?: string;
  endpoint?: string;
  upstreamStatus?: number;
  upstreamStatusText?: string;
  latencyMs?: number;
};

function toRpcTestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * `/v1/rpc/test` resolves whatever provider the organization has *saved*, not
 * one passed in — so the caller must only offer this for the active provider.
 * The requested/resolved comparison stays as the guard against a save that
 * silently did not take.
 */
export async function runRpcProviderTest(
  requestedProvider: OrganizationRpcProvider,
  t: Translate
): Promise<RpcTestResult> {
  const startedAt = Date.now();

  try {
    const result = await dashboardFetch<{ data: RpcProxyResponse }>(
      "/api/dashboard/settings/rpc-test",
      {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: "org-rpc-test",
          method: "getVersion",
          params: [],
        },
      }
    );

    const latencyMs = Date.now() - startedAt;

    if (!result.ok) {
      return {
        status: "error",
        reason: "request_failed",
        message: result.error,
        requestedProvider,
        latencyMs,
      };
    }

    const {
      provider: { id: resolvedProvider, endpoint, selectionMode },
      upstream,
    } = result.data.data;

    if (requestedProvider !== "default" && resolvedProvider !== requestedProvider) {
      return {
        status: "error",
        reason: "mismatch",
        message: t("DashboardCustody.rpcTestMismatch", {
          requested: rpcProviderLabel(requestedProvider),
          resolved: rpcProviderLabel(resolvedProvider),
        }),
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    if (!upstream.ok) {
      return {
        status: "error",
        reason: "upstream",
        message: t("DashboardCustody.rpcUpstreamReturned", {
          status: upstream.status,
          statusText: upstream.statusText,
        }),
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    return {
      status: "success",
      message: t("DashboardCustody.rpcTestPassed", {
        status: upstream.status,
        statusText: upstream.statusText,
        latency: latencyMs,
      }),
      requestedProvider,
      resolvedProvider,
      selectionMode,
      endpoint,
      upstreamStatus: upstream.status,
      upstreamStatusText: upstream.statusText,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "error",
      reason: "request_failed",
      message: toRpcTestErrorMessage(error, t("DashboardCustody.failedToTestRpcProvider")),
      requestedProvider,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * The relay's own vocabulary for how it picked an endpoint. Rendering the raw
 * enum put `project_connection` in front of readers who have no reason to know
 * the API's spelling.
 */
const SELECTION_MODE_KEYS: Record<string, MessageKey> = {
  project_connection: "DashboardCustody.rpcSelectionProjectConnection",
  organization_connection: "DashboardCustody.rpcSelectionOrganizationConnection",
  project_provider: "DashboardCustody.rpcSelectionProjectProvider",
  project_custom_provider: "DashboardCustody.rpcSelectionProjectCustomProvider",
  organization_provider: "DashboardCustody.rpcSelectionOrganizationProvider",
  round_robin_default: "DashboardCustody.rpcSelectionRoundRobinDefault",
};

/** Falls back to the raw mode so an unmapped one still says something. */
function selectionModeLabel(mode: string, t: Translate): string {
  const key = SELECTION_MODE_KEYS[mode];
  return key ? t(key) : mode;
}

export function RpcTestResultPanel({ result }: { result: RpcTestResult }) {
  const t = useTranslations();
  // Three outcomes, not two: a mismatch reached the upstream fine.
  const badge =
    result.status === "success"
      ? { variant: "success" as const, label: t("DashboardCustody.rpcDetailReachable") }
      : result.reason === "mismatch"
        ? { variant: "warning" as const, label: t("DashboardCustody.rpcDetailMismatch") }
        : { variant: "danger" as const, label: t("DashboardCustody.rpcDetailUnreachable") };
  return (
    <div className="rounded-xl border border-border-default bg-fill-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-primary">
          {t("DashboardCustody.rpcDetailTitle")}
        </span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      {result.status === "error" ? (
        <p
          className={
            result.reason === "mismatch" ? "mt-2 text-sm text-warning" : "mt-2 text-sm text-error"
          }
        >
          {result.message}
        </p>
      ) : null}
      <dl className="mt-3 grid gap-2 text-sm">
        {result.resolvedProvider ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary">{t("DashboardCustody.rpcDetailResolvedProvider")}</dt>
            <dd className="text-primary">{rpcProviderLabel(result.resolvedProvider)}</dd>
          </div>
        ) : null}
        {result.selectionMode ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary">{t("DashboardCustody.rpcDetailSelectionMode")}</dt>
            <dd className="text-primary">{selectionModeLabel(result.selectionMode, t)}</dd>
          </div>
        ) : null}
        {result.endpoint ? (
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-tertiary">{t("DashboardCustody.rpcDetailEndpoint")}</dt>
            {/* Not a code surface: an endpoint in a settings row reads as
                product UI, so it keeps the body text style. */}
            <dd className="min-w-0 break-all text-right text-primary">{result.endpoint}</dd>
          </div>
        ) : null}
        {result.upstreamStatus !== undefined ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary">{t("DashboardCustody.rpcDetailUpstream")}</dt>
            <dd className="text-primary">
              {result.upstreamStatus}
              {result.upstreamStatusText ? ` ${result.upstreamStatusText}` : ""}
            </dd>
          </div>
        ) : null}
        {result.latencyMs !== undefined ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary">{t("DashboardCustody.rpcDetailLatency")}</dt>
            <dd className="text-primary">
              {t("DashboardCustody.rpcDetailLatencyValue", { ms: result.latencyMs })}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
