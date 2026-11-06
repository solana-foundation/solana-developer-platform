import { auth } from "@clerk/nextjs/server";
import { type IntegrationFamily, projectIntegrationsSchema } from "@sdp/types/integrations";
import type { RampProviderId } from "@sdp/types/provider-access";
import { redirect } from "next/navigation";
import { IntegrationsCatalog } from "@/app/(session)/dashboard/[projectId]/integrations/integrations-catalog";
import type { OnboardingStatusResponse } from "@/app/(session)/dashboard/[projectId]/onboarding-status";
import { privateChannels } from "@/flags";
import { getOfferedRampProviders } from "@/flags/ramps";
import { createTimedTrace } from "@/lib/request-tracing";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";

export default async function IntegrationsPage() {
  const { orgId } = await auth();
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
  const [integrations, privateChannelsEnabled, offeredRampProviders] = await Promise.all([
    trace.step("fetch_integrations", async () =>
      projectIntegrationsSchema.parse(await projectClient.fetch<unknown>("/v1/integrations"))
    ),
    privateChannels(),
    getOfferedRampProviders(),
  ]);

  trace.log({ ok: true });

  return (
    <IntegrationsCatalog
      integrations={{
        ...integrations,
        families: integrations.families.flatMap((family) =>
          familyForViewer(family, { privateChannelsEnabled, offeredRampProviders })
        ),
      }}
    />
  );
}

// Private Channels and each ramp provider also have per-user flag targeting the API
// cannot see, so the page drops whatever those flags leave out for this viewer.
function familyForViewer(
  family: IntegrationFamily,
  flags: { privateChannelsEnabled: boolean; offeredRampProviders: readonly RampProviderId[] }
): IntegrationFamily[] {
  if (family.family === "private_channels") {
    return flags.privateChannelsEnabled ? [family] : [];
  }
  if (family.family === "ramps") {
    const integrations = family.integrations.filter((integration) =>
      flags.offeredRampProviders.includes(integration.provider)
    );
    return integrations.length > 0 ? [{ ...family, integrations }] : [];
  }
  return [family];
}
