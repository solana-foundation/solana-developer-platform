import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { isKnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import { createRequestScopedSdpApiClients, type SdpApiClient } from "@/lib/sdp-api";
import { IntegrationsCatalog } from "./integrations-catalog";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "./integrations-status";

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

export default async function IntegrationsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.integrations.page");
  const { organizationClient, projectClient } = await trace.step("create_sdp_api_clients", () =>
    createRequestScopedSdpApiClients({
      organizationTraceContext: trace.childContext("dashboard.integrations.org.api"),
      projectTraceContext: trace.childContext("dashboard.integrations.api"),
    })
  );
  const onboarding = await trace.step("fetch_onboarding_status", () =>
    organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
  );
  if (!onboarding.linked || !onboarding.organization) {
    redirect("/dashboard");
  }
  if (!projectClient) {
    throw new Error("Selected project required");
  }
  const organizationId = onboarding.organization.id;

  const [availability, connectedProviders] = await Promise.all([
    trace.step("fetch_provider_access", () =>
      fetchProviderAvailability(projectClient.request, organizationId)
    ),
    // null, not [] — an empty list claims nothing is connected and offers
    // Configure for providers that are already active. Unknown must render as
    // unknown, never as installable.
    trace.step("fetch_custody_configs", () =>
      getConnectedCustodyProviders(projectClient.request).catch(() => null)
    ),
  ]);

  trace.log({ ok: true });

  return (
    <IntegrationsCatalog
      custody={
        connectedProviders === null
          ? null
          : resolveCustodyIntegrations({
              connectedProviders,
              enabledProviders: availability.enabledCustodyProviders,
            })
      }
      rpc={resolveRpcIntegrations({
        // The shell only routes here after onboarding, so a missing setting
        // means the organization runs on SDP's default RPC, not "none".
        selectedProvider: onboarding.setup?.rpcProvider ?? "default",
        entries: availability.providers.rpc,
      })}
      ramps={resolveRampIntegrations(availability.providers.ramps)}
      compliance={resolveComplianceIntegrations(availability.providers.compliance)}
    />
  );
}
