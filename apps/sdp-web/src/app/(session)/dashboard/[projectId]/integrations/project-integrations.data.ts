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
  for (const family of integrations.families) {
    if (family.family === "custody") {
      return family.integrations.find((integration) => integration.provider === provider) ?? null;
    }
  }
  return null;
}
