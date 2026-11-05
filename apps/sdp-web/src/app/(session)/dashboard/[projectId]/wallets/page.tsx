import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary } from "@sdp/types/custody";
import { redirect } from "next/navigation";
import type { OnboardingStatusResponse } from "@/app/(session)/dashboard/[projectId]/onboarding-status";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";
import {
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { getTranslations } from "@/i18n/server";
import { createTimedTrace } from "@/lib/request-tracing";
import {
  createRequestScopedSdpApiClients,
  requestProjectHref,
  type SdpApiClient,
} from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";
import { WalletsWorkspace } from "./wallets-workspace";

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

/** A failed read's message, or the fallback when what it threw was not an Error. */
function settledError(result: SettledResult<unknown>, fallback: string): string | null {
  if (result.ok) return null;
  return result.error instanceof Error ? result.error.message : fallback;
}

/** The providers with an active config that the catalogue knows. */
function activeKnownProviders(configs: readonly CustodyConfigSummary[]): KnownCustodyProvider[] {
  return configs
    .filter((config) => config.status === "active")
    .map((config) => config.provider)
    .filter(isKnownCustodyProvider);
}

async function getCustodyConfigs(
  request: SdpApiClient["request"]
): Promise<{ configs: CustodyConfigSummary[] }> {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: { configs: CustodyConfigSummary[] };
  };
  return json.data;
}

export default async function WalletsPage() {
  const [t, { orgId }] = await Promise.all([getTranslations(), auth()]);
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.wallets.page");

  try {
    const { organizationClient, projectClient } = await trace.step("create_sdp_api_clients", () =>
      createRequestScopedSdpApiClients({
        organizationTraceContext: trace.childContext("dashboard.wallets.org.api"),
        projectTraceContext: trace.childContext("dashboard.wallets.api"),
      })
    );
    const onboarding = await trace.step("fetch_onboarding_status", () =>
      organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
    );

    if (!onboarding.linked) {
      trace.log({
        ok: true,
        linked: false,
      });

      redirect(
        `${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent(await requestProjectHref("/dashboard/wallets"))}`
      );
    }

    const configsResult = await trace.step("fetch_custody_configs", () =>
      settle(getCustodyConfigs(projectClient.request))
    );

    const connectedProviders = configsResult.ok
      ? activeKnownProviders(configsResult.value.configs)
      : [];
    const configsError = settledError(
      configsResult,
      t("DashboardCustody.unableToLoadWalletProviders")
    );

    trace.log({
      ok: true,
      linked: true,
      connectedProviderCount: connectedProviders.length,
    });

    return (
      <WalletsWorkspace
        apiBaseUrl={resolvePlaygroundApiBaseUrl()}
        connectedProviders={connectedProviders}
        configsError={configsError}
      />
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
