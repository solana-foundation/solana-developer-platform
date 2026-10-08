import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  CUSTODY_PROVIDERS,
  type CustodyMode,
  type CustodyProvider,
  EARN_PROVIDERS,
  type EarnProviderId,
  type Project,
  type ProjectProviderAvailability,
  type ProjectProviderAvailabilityEntry,
  RAMP_PROVIDERS,
  type RampProviderId,
} from "@sdp/types";

/**
 * Builds a Project's provider availability the way the API returns it: every
 * provider the deployment knows, in family and tuple order, with the listed
 * ones available and the rest not.
 *
 * @param input - The Project and the providers it can use.
 * @param input.project - The Project the availability belongs to.
 * @param input.custody - The custody providers with modes, each with its modes.
 * @param input.compliance - The available compliance providers.
 * @param input.ramps - The available ramp providers.
 * @param input.earn - The available earn providers.
 * @returns The Project's provider availability.
 */
export function projectProviderAvailability(input: {
  project: Project;
  custody: readonly { provider: CustodyProvider; modes: CustodyMode[] }[];
  compliance: readonly ComplianceProviderId[];
  ramps: readonly RampProviderId[];
  earn: readonly EarnProviderId[];
}): ProjectProviderAvailability {
  const providers: ProjectProviderAvailabilityEntry[] = [
    ...CUSTODY_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry => ({
        family: "custody",
        provider,
        modes: input.custody.flatMap((entry) => (entry.provider === provider ? entry.modes : [])),
      })
    ),
    ...COMPLIANCE_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry => ({
        family: "compliance",
        provider,
        available: input.compliance.includes(provider),
      })
    ),
    ...RAMP_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry => ({
        family: "ramps",
        provider,
        available: input.ramps.includes(provider),
      })
    ),
    ...EARN_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry => ({
        family: "earn",
        provider,
        available: input.earn.includes(provider),
      })
    ),
  ];
  return { projectId: input.project.id, environment: input.project.environment, providers };
}
