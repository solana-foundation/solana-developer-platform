import { auth } from "@clerk/nextjs/server";
import { BYOK_CUSTODY_PROVIDERS, type CustodyConfigSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import { createTimedTrace } from "@/lib/request-tracing";
import {
  createRequestScopedSdpApiClients,
  requestProjectHref,
  type SdpApiClient,
} from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "../../onboarding-status";
import { fetchConnectionPickerOptions } from "../connections/connections.data";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "../provider-catalog";
import { WalletSetupFlow } from "./wallet-setup-flow";

interface CustodySetupPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
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
    data: { configs: CustodyConfigSummary[] };
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

  const { organizationClient, projectClient } = await trace.step("create_sdp_api_clients", () =>
    createRequestScopedSdpApiClients({
      organizationTraceContext: trace.childContext("dashboard.custody.setup.org.api"),
      projectTraceContext: trace.childContext("dashboard.custody.setup.api"),
    })
  );
  const onboarding = await trace.step("fetch_onboarding_status", () =>
    organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
  );

  if (!onboarding.linked || !onboarding.organization) {
    redirect(await requestProjectHref("/dashboard/wallets"));
  }
  // Connections are BYOK custody, so the flow offers them only for a provider
  // whose modes include `byok`; they are read alongside availability rather than
  // after it.
  const [connectedProviders, providerAvailability, connectionsByProvider] = await Promise.all([
    trace.step("fetch_custody_configs", () => getConnectedCustodyProviders(projectClient.request)),
    trace.step("fetch_provider_availability", () =>
      fetchProjectProviderAvailability(projectClient)
    ),
    trace.step("fetch_connection_picker_options", () =>
      Promise.all(
        BYOK_CUSTODY_PROVIDERS.map((provider) =>
          fetchConnectionPickerOptions(projectClient.request, provider)
        )
      )
    ),
  ]);
  const custodyAvailability = availableCustodyProviders(providerAvailability);
  const connections = connectionsByProvider.flat();

  trace.log({
    ok: true,
    connectedProviderCount: connectedProviders.length,
    availableProviderCount: custodyAvailability.length,
    connectionCount: connections.length,
  });

  return (
    <WalletSetupFlow
      connectedProviders={connectedProviders}
      custodyAvailability={custodyAvailability}
      environment={providerAvailability.environment}
      initialProvider={initialProvider}
      connections={connections}
    />
  );
}
