import { auth } from "@clerk/nextjs/server";
import { projectIntegrationsSchema } from "@sdp/types/integrations";
import { redirect } from "next/navigation";
import { IntegrationsCatalog } from "@/app/(session)/dashboard/[projectId]/integrations/integrations-catalog";
import type { OnboardingStatusResponse } from "@/app/(session)/dashboard/[projectId]/onboarding-status";
import { privateChannels } from "@/flags";
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
  const [integrations, privateChannelsEnabled] = await Promise.all([
    trace.step("fetch_integrations", async () =>
      projectIntegrationsSchema.parse(await projectClient.fetch<unknown>("/v1/integrations"))
    ),
    privateChannels(),
  ]);

  trace.log({ ok: true });

  // Private Channels also has per-user flag targeting the API cannot see, so its
  // family stays off the page for anyone the flag leaves out.
  return (
    <IntegrationsCatalog
      integrations={{
        ...integrations,
        families: integrations.families.filter(
          (family) => privateChannelsEnabled || family.family !== "private_channels"
        ),
      }}
    />
  );
}
