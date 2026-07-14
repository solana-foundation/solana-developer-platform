import { auth, clerkClient } from "@clerk/nextjs/server";
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
import {
  WalletsOnboardingSkeleton,
  WalletsPageSkeleton,
} from "@/app/dashboard/wallets/wallets-page-skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import { createOrgSdpApiClient, createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../onboarding-status";
import { WalletsWorkspace } from "./wallets-workspace";

interface ClerkOrganizationSummary {
  id: string;
  name: string | null;
  slug: string | null;
}

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
  // biome-ignore lint/security/noSecrets: Public API path with query flags for wallet listing.
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

async function getClerkOrganizationSummary(
  organizationId: string
): Promise<ClerkOrganizationSummary> {
  try {
    const client = await clerkClient();
    const organization = await client.organizations.getOrganization({
      organizationId,
    });
    return {
      id: organization.id,
      name: organization.name ?? null,
      slug: organization.slug ?? null,
    };
  } catch {
    return {
      id: organizationId,
      name: null,
      slug: null,
    };
  }
}

async function OnboardingGateSection({ orgId }: { orgId: string }) {
  const t = await getTranslations();
  const organization = await getClerkOrganizationSummary(orgId);

  return (
    <Card className="rounded-[24px] border-border-subtle shadow-none">
      <CardHeader>
        <CardTitle>{t("DashboardCustody.waitingForOrganizationSync")}</CardTitle>
        <CardDescription>{t("DashboardCustody.organizationSyncDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-border-default bg-fill-subtle p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-secondary">{t("DashboardCustody.organizationName")}</span>
            <span className="font-medium text-primary">
              {organization.name ?? t("DashboardCustody.unavailable")}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-secondary">{t("DashboardCustody.organizationSlug")}</span>
            <span className="font-mono text-xs text-primary">
              {organization.slug ?? t("DashboardCustody.unavailable")}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-secondary">{t("DashboardCustody.clerkOrganizationId")}</span>
            <span className="font-mono text-xs text-primary">{organization.id}</span>
          </div>
        </div>
        <p className="text-sm text-secondary">{t("DashboardCustody.organizationSyncHelp")}</p>
      </CardContent>
    </Card>
  );
}

export default async function CustodyPage() {
  const t = await getTranslations();
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.custody.page");

  try {
    const orgClient = await trace.step("create_org_sdp_api_client", () =>
      createOrgSdpApiClient(trace.childContext("dashboard.custody.org.api"))
    );
    const onboarding = await trace.step("fetch_onboarding_status", () =>
      orgClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
    );

    if (!onboarding.linked) {
      trace.log({
        ok: true,
        linked: false,
      });

      return (
        <Suspense fallback={<WalletsOnboardingSkeleton />}>
          <OnboardingGateSection orgId={orgId} />
        </Suspense>
      );
    }

    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.custody.api"))
    );
    const [configsResult, walletsResult, apiKeysResult, providerAccessResult] = await Promise.all([
      trace.step("fetch_custody_configs", () => settle(getCustodyConfigs(apiClient.request))),
      trace.step("fetch_custody_wallets", () => settle(getCustodyWallets(apiClient.request))),
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
      trace.step("fetch_provider_access", () =>
        onboarding.organization
          ? settle(fetchProviderAvailability(apiClient.request, onboarding.organization.id))
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
      <Suspense fallback={<WalletsPageSkeleton />}>
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
