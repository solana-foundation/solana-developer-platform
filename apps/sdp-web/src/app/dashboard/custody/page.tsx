import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary, CustodyWalletSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import {
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import { WalletsOverviewSkeleton } from "@/app/dashboard/wallets/wallet-route-skeletons";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import { createRequestScopedSdpApiClients, type SdpApiClient } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";
import type { OnboardingStatusResponse } from "../onboarding-status";
import { WalletsWorkspace } from "./wallets-workspace";

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

async function getCustodyConfigs(
  request: SdpApiClient["request"]
): Promise<{ configs: CustodyConfigSummary[]; defaultConfigId: string | null }> {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: { configs: CustodyConfigSummary[]; defaultConfigId: string | null };
  };
  return json.data;
}

async function getCustodyWallets(
  request: SdpApiClient["request"]
): Promise<CustodyWalletSummary[]> {
  // Wallet cards refresh balances client-side; avoid blocking the overview render on balance RPCs.
  const res = await request("/v1/wallets?includeAllProviders=true");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data?: { wallets?: CustodyWalletSummary[] };
  };
  return json.data?.wallets ?? [];
}

export default async function CustodyPage() {
  const [t, { getToken, userId, orgId }] = await Promise.all([getTranslations(), auth()]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.custody.page");

  try {
    const { organizationClient, projectClient } = await trace.step("create_sdp_api_clients", () =>
      createRequestScopedSdpApiClients({
        getToken,
        organizationTraceContext: trace.childContext("dashboard.custody.org.api"),
        projectTraceContext: trace.childContext("dashboard.custody.api"),
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

      redirect(`${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent("/dashboard/wallets")}`);
    }

    if (!projectClient) {
      throw new Error("Selected project required");
    }
    const [configsResult, walletsResult, apiKeysResult, providerAccessResult] = await Promise.all([
      trace.step("fetch_custody_configs", () => settle(getCustodyConfigs(projectClient.request))),
      trace.step("fetch_custody_wallets", () => settle(getCustodyWallets(projectClient.request))),
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(projectClient.request)),
      trace.step("fetch_provider_access", () =>
        onboarding.organization
          ? settle(fetchProviderAvailability(projectClient.request, onboarding.organization.id))
          : Promise.resolve({
              ok: false as const,
              error: new Error("Organization is not linked"),
            })
      ),
    ]);

    const connectedProviders: KnownCustodyProvider[] = configsResult.ok
      ? configsResult.value.configs
          .filter((config) => config.status === "active")
          .map((config) => config.provider)
          .filter(isKnownCustodyProvider)
      : [];

    const configsError = configsResult.ok
      ? null
      : configsResult.error instanceof Error
        ? configsResult.error.message
        : t("DashboardCustody.unableToLoadWalletProviders");
    const walletsError = walletsResult.ok
      ? null
      : walletsResult.error instanceof Error
        ? walletsResult.error.message
        : t("DashboardCustody.unableToLoadWallets");
    const apiKeys = apiKeysResult.ok ? (apiKeysResult.data ?? []) : [];
    const enabledProviders = providerAccessResult.ok
      ? providerAccessResult.value.enabledCustodyProviders
      : connectedProviders;

    trace.log({
      ok: true,
      linked: true,
      connectedProviderCount: connectedProviders.length,
      enabledProviderCount: enabledProviders.length,
      walletCount: walletsResult.ok ? walletsResult.value.length : 0,
      apiKeyCount: apiKeys.length,
    });

    return (
      <Suspense fallback={<WalletsOverviewSkeleton />}>
        <WalletsWorkspace
          apiBaseUrl={resolvePlaygroundApiBaseUrl()}
          apiKeys={apiKeys}
          connectedProviders={connectedProviders}
          enabledProviders={enabledProviders}
          configsError={configsError}
          wallets={walletsResult.ok ? walletsResult.value : []}
          walletsError={walletsError}
        />
      </Suspense>
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
