import type {
  ComplianceProviderId,
  OrganizationProviderAvailabilityResponse,
  OrganizationRpcProvider,
  ProviderAvailabilityEntry,
  RampProviderId,
} from "@sdp/types";
import {
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import type { SdpApiClient } from "@/lib/sdp-api";

export interface DashboardProviderAvailability extends OrganizationProviderAvailabilityResponse {
  enabledCustodyProviders: KnownCustodyProvider[];
  enabledRpcProviders: OrganizationRpcProvider[];
  enabledComplianceProviders: ComplianceProviderId[];
  rampProviderAccess: RampProviderAccess;
}

/**
 * Whether any ramp provider is usable by the organization — entitled,
 * configured, and enabled. `null` (e.g. a failed provider-access fetch)
 * means none are usable.
 */
export type RampProviderAccess = Readonly<
  Partial<Record<RampProviderId, ProviderAvailabilityEntry>>
>;

export function hasEnabledRampProvider(access: RampProviderAccess | null): boolean {
  if (access === null) {
    return false;
  }
  return Object.values(access).some((entry) => entry.entitled && entry.configured && entry.enabled);
}

/**
 * Restricts a ramp provider access record to the feature-flag-enabled providers.
 *
 * @param access - The provider access record reported for the organization.
 * @param enabledProviders - The ramp providers enabled by feature flags.
 * @returns The access record without flagged-off providers.
 */
export function filterEnabledRampProviderAccess(
  access: RampProviderAccess,
  enabledProviders: readonly RampProviderId[]
): RampProviderAccess {
  const enabled = new Set<string>(enabledProviders);
  return Object.fromEntries(Object.entries(access).filter(([provider]) => enabled.has(provider)));
}

export async function fetchProviderAvailability(
  request: SdpApiClient["request"],
  organizationId: string
): Promise<DashboardProviderAvailability> {
  const response = await request(
    `/v1/organizations/${encodeURIComponent(organizationId)}/provider-access`
  );
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
    rampProviderAccess: data.providers.ramps,
  };
}
