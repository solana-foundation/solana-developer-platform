import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import { createOrgSdpApiClient, createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../../onboarding-status";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "../provider-catalog";
import { WalletSetupFlow } from "./wallet-setup-flow";

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface CustodySetupPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function settle<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function getSearchParamValue(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  key: string
): string | null {
  const value = searchParams?.[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function parseProvider(value: string | null): KnownCustodyProvider | null {
  return value && isKnownCustodyProvider(value) ? value : null;
}

async function getConnectedCustodyProviders(
  request: SdpApiClient["request"]
): Promise<KnownCustodyProvider[]> {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: { configs: CustodyConfigSummary[]; defaultConfigId: string | null };
  };

  return json.data.configs
    .filter((config) => config.status === "active")
    .map((config) => config.provider)
    .filter(isKnownCustodyProvider);
}

export default async function CustodySetupPage({ searchParams }: CustodySetupPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.custody.setup.page");
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialProvider = parseProvider(getSearchParamValue(resolvedSearchParams, "provider"));

  const orgClient = await trace.step("create_org_sdp_api_client", () =>
    createOrgSdpApiClient(trace.childContext("dashboard.custody.setup.org.api"))
  );
  const onboarding = await trace.step("fetch_onboarding_status", () =>
    orgClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
  );

  if (!onboarding.linked || !onboarding.organization) {
    redirect("/dashboard/wallets");
  }
  const organizationId = onboarding.organization.id;

  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.custody.setup.api"))
  );

  const [configsResult, providerAccessResult] = await Promise.all([
    trace.step("fetch_custody_configs", () =>
      settle(getConnectedCustodyProviders(apiClient.request))
    ),
    trace.step("fetch_provider_access", () =>
      settle(fetchProviderAvailability(apiClient.request, organizationId))
    ),
  ]);

  const connectedProviders = configsResult.ok ? configsResult.value : [];
  const enabledProviders = providerAccessResult.ok
    ? providerAccessResult.value.enabledCustodyProviders
    : connectedProviders;

  trace.log({
    ok: true,
    connectedProviderCount: connectedProviders.length,
    enabledProviderCount: enabledProviders.length,
  });

  return (
    <WalletSetupFlow
      connectedProviders={connectedProviders}
      enabledProviders={enabledProviders}
      initialProvider={initialProvider}
    />
  );
}
