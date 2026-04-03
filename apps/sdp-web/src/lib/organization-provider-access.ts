import {
  type KnownCustodyProvider,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import type { SdpApiClient } from "@/lib/sdp-api";
import type {
  ComplianceProviderId,
  OrganizationProviderAvailabilityResponse,
  OrganizationRpcProvider,
  RampProviderId,
} from "@sdp/types";

export interface DashboardOrganizationProviderAccess
  extends OrganizationProviderAvailabilityResponse {
  enabledCustodyProviders: KnownCustodyProvider[];
  enabledRpcProviders: OrganizationRpcProvider[];
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
}

export async function fetchOrganizationProviderAccess(
  request: SdpApiClient["request"],
  organizationId: string
): Promise<DashboardOrganizationProviderAccess> {
  const response = await request(`/v1/organizations/${encodeURIComponent(organizationId)}/provider-access`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data: OrganizationProviderAvailabilityResponse };
  const data = json.data;

  return {
    ...data,
    enabledCustodyProviders: Object.entries(data.providers.custody)
      .filter(([, entry]) => entry.enabled)
      .map(([provider]) => provider)
      .filter(isKnownCustodyProvider),
    enabledRpcProviders: Object.entries(data.providers.rpc)
      .filter(([, entry]) => entry.enabled)
      .map(([provider]) => provider as OrganizationRpcProvider),
    enabledComplianceProviders: Object.entries(data.providers.compliance)
      .filter(([, entry]) => entry.enabled)
      .map(([provider]) => provider as ComplianceProviderId),
    enabledRampProviders: Object.entries(data.providers.ramps)
      .filter(([, entry]) => entry.enabled)
      .map(([provider]) => provider as RampProviderId),
  };
}
