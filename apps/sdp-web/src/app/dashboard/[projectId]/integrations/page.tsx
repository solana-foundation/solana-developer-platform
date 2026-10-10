import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigSummary, PrivateChannelInstanceEnvelope } from "@sdp/types";
import { redirect } from "next/navigation";
import { isKnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { custody, privateChannels } from "@/flags";
import { getOfferedRampProviders } from "@/flags/ramps";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import {
  availableComplianceProviders,
  availableCustodyProviders,
  availableRampProviders,
} from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createRequestScopedSdpApiClients, type SdpApiClient } from "@/lib/sdp-api";
import { isIntegrationFamilyEnabled } from "./integration-feature-gates";
import { IntegrationsCatalog } from "./integrations-catalog";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolvePrivacyIntegrations,
  resolveRampIntegrations,
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

async function getPrivateChannelsActive(client: SdpApiClient): Promise<boolean | null> {
  try {
    const response = await client.fetch<PrivateChannelInstanceEnvelope>(
      "/v1/private-channels/instance"
    );
    return response.instance?.isActive === true;
  } catch {
    return null;
  }
}

/**
 * The integrations catalog for the selected project, gated by the dashboard's
 * module flags and listing only the providers the project can use.
 *
 * @returns The rendered catalog.
 */
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
  const [t, custodyEnabled, rampProviders, privateChannelsEnabled] = await Promise.all([
    getTranslations(),
    custody(),
    getOfferedRampProviders(),
    privateChannels(),
  ]);
  const complianceEnabled = isModuleInDeploymentReleaseChannel("compliance");
  const integrationFlags = {
    custody: custodyEnabled,
    rampProviders,
    compliance: complianceEnabled,
    privateChannels: privateChannelsEnabled,
  };
  const [availability, connectedProviders, privateChannelsActive] = await Promise.all([
    trace.step("fetch_provider_availability", () =>
      fetchProjectProviderAvailability(projectClient)
    ),
    // null, not [] — an empty list claims nothing is connected and offers
    // Configure for providers that are already active. Unknown must render as
    // unknown, never as installable.
    custodyEnabled
      ? trace.step("fetch_custody_configs", () =>
          getConnectedCustodyProviders(projectClient.request).catch(() => null)
        )
      : Promise.resolve([]),
    privateChannelsEnabled
      ? trace.step("fetch_private_channels_instance", () => getPrivateChannelsActive(projectClient))
      : Promise.resolve(false),
  ]);

  trace.log({ ok: true });

  return (
    <IntegrationsCatalog
      custody={
        !custodyEnabled
          ? []
          : connectedProviders === null
            ? null
            : resolveCustodyIntegrations({
                connectedProviders,
                custodyAvailability: availableCustodyProviders(availability),
              })
      }
      ramps={
        isIntegrationFamilyEnabled("ramps", integrationFlags)
          ? resolveRampIntegrations(availableRampProviders(availability), rampProviders)
          : []
      }
      compliance={
        isIntegrationFamilyEnabled("compliance", integrationFlags)
          ? resolveComplianceIntegrations(availableComplianceProviders(availability))
          : []
      }
      privacy={resolvePrivacyIntegrations({
        enabled: privateChannelsEnabled,
        active: privateChannelsActive,
        label: t("Shared.dashboardShell.privateChannels"),
      })}
      enabledFamilies={[
        ...(custodyEnabled ? (["custody"] as const) : []),
        ...(rampProviders.length > 0 ? (["ramps"] as const) : []),
        ...(complianceEnabled ? (["compliance"] as const) : []),
        ...(privateChannelsEnabled ? (["privacy"] as const) : []),
      ]}
    />
  );
}
