import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { isKnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createRequestScopedSdpApiClients, type SdpApiClient } from "@/lib/sdp-api";
import { isKnownIntegrationProvider, resolveIntegrationDetail } from "../integration-detail";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "../integrations-status";
import { IntegrationDetailView } from "./integration-detail-view";

async function getConnectedCustodyProviders(request: SdpApiClient["request"]) {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { configs: CustodyConfigSummary[] } };
  return json.data.configs
    .filter((config) => config.status === "active")
    .map((config) => config.provider)
    .filter(isKnownCustodyProvider);
}

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  if (!isKnownIntegrationProvider(provider)) {
    notFound();
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();
  const onboarding =
    await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
  if (!onboarding.linked || !onboarding.organization) {
    redirect("/dashboard");
  }
  if (!projectClient) {
    throw new Error("Selected project required");
  }
  const organizationId = onboarding.organization.id;

  const [availability, connectedProviders] = await Promise.all([
    fetchProviderAvailability(projectClient.request, organizationId),
    getConnectedCustodyProviders(projectClient.request).catch(() => null),
  ]);

  const detail = resolveIntegrationDetail({
    provider,
    custody:
      connectedProviders === null
        ? null
        : resolveCustodyIntegrations({
            connectedProviders,
            enabledProviders: availability.enabledCustodyProviders,
          }),
    rpc: resolveRpcIntegrations({
      selectedProvider: onboarding.setup?.rpcProvider ?? "default",
      entries: availability.providers.rpc,
    }),
    ramps: resolveRampIntegrations(availability.providers.ramps),
    compliance: resolveComplianceIntegrations(availability.providers.compliance),
  });

  if (!detail) {
    notFound();
  }

  return <IntegrationDetailView detail={detail} />;
}
