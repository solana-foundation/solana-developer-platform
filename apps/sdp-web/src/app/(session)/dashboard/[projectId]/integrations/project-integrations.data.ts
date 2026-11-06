import {
  type CustodyIntegration,
  type ProjectIntegrations,
  projectIntegrationsSchema,
} from "@sdp/types/integrations";
import type { KnownCustodyProvider } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import type { SdpApiClient } from "@/lib/sdp-api";

export async function fetchProjectIntegrations(client: SdpApiClient): Promise<ProjectIntegrations> {
  return projectIntegrationsSchema.parse(await client.fetch<unknown>("/v1/integrations"));
}

export function findCustodyIntegration(
  integrations: ProjectIntegrations,
  provider: KnownCustodyProvider
): CustodyIntegration | null {
  const custody = integrations.families.find((family) => family.family === "custody");
  return custody?.integrations.find((integration) => integration.provider === provider) ?? null;
}
