import type {
  ComplianceProviderId,
  CustodyMode,
  CustodyProvider,
  OrganizationProviderAvailabilityResponse,
  ProjectProviderAvailability,
  ProjectProviderAvailabilityEntry,
  ProviderAvailabilityEntry,
  RampProviderId,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export interface DashboardProviderAvailability extends OrganizationProviderAvailabilityResponse {
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
    enabledComplianceProviders: Object.entries(data.providers.compliance)
      .filter(([, entry]) => entry.enabled)
      .map(([provider]) => provider as ComplianceProviderId),
    rampProviderAccess: data.providers.ramps,
  };
}

/** The custody modes a provider the project can use may be set up in. */
export type AvailableCustodyModes = readonly [CustodyMode, ...CustodyMode[]];

/** A custody provider the project can set up in at least one mode. */
export type ProjectCustodyAvailability = Omit<
  Extract<ProjectProviderAvailabilityEntry, { family: "custody" }>,
  "modes"
> & { modes: AvailableCustodyModes };

/**
 * Whether a provider offers at least one custody mode.
 *
 * @param modes - The modes a project availability entry reports.
 * @returns True when `modes` is not empty.
 */
function hasCustodyMode(modes: readonly CustodyMode[]): modes is AvailableCustodyModes {
  return modes.length > 0;
}

/**
 * The custody providers the project can set up in at least one mode.
 *
 * @param availability - The project's provider availability.
 * @returns The custody entries whose `modes` are not empty, in tuple order.
 */
export function availableCustodyProviders(
  availability: ProjectProviderAvailability
): ProjectCustodyAvailability[] {
  return availability.providers.flatMap((entry): ProjectCustodyAvailability[] => {
    if (entry.family !== "custody") {
      return [];
    }
    const { modes } = entry;
    return hasCustodyMode(modes) ? [{ ...entry, modes }] : [];
  });
}

/**
 * The ramp providers the project can use.
 *
 * @param availability - The project's provider availability.
 * @returns The available ramp providers, in tuple order.
 */
export function availableRampProviders(
  availability: ProjectProviderAvailability
): RampProviderId[] {
  return availability.providers.flatMap((entry) =>
    entry.family === "ramps" && entry.available ? [entry.provider] : []
  );
}

/**
 * The compliance providers the project can use.
 *
 * @param availability - The project's provider availability.
 * @returns The available compliance providers, in tuple order.
 */
export function availableComplianceProviders(
  availability: ProjectProviderAvailability
): ComplianceProviderId[] {
  return availability.providers.flatMap((entry) =>
    entry.family === "compliance" && entry.available ? [entry.provider] : []
  );
}

/**
 * Whether the project can use a provider in any family: a custody provider in
 * at least one mode, any other provider when it is available.
 *
 * @param availability - The project's provider availability.
 * @param provider - A provider id from any family.
 * @returns False for a provider the project cannot use or the deployment does not know.
 */
export function isProviderAvailableForProject(
  availability: ProjectProviderAvailability,
  provider: string
): boolean {
  return availability.providers.some(
    (entry) =>
      entry.provider === provider &&
      (entry.family === "custody" ? entry.modes.length > 0 : entry.available)
  );
}

/**
 * Whether the project may set a custody provider up in a mode.
 *
 * @param availability - The project's provider availability.
 * @param provider - The custody provider.
 * @param mode - The custody mode.
 * @returns True when the provider's `modes` include `mode`.
 */
export function offersCustodyMode(
  availability: ProjectProviderAvailability,
  provider: CustodyProvider,
  mode: CustodyMode
): boolean {
  return availability.providers.some(
    (entry) =>
      entry.family === "custody" && entry.provider === provider && entry.modes.includes(mode)
  );
}
