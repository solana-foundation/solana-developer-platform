import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  CUSTODY_MODES,
  CUSTODY_PROVIDERS,
  type CustodyMode,
  type CustodyProvider,
  EARN_PROVIDERS,
  type EarnProviderId,
  isCustodyModeAllowedInEnvironment,
  type Project,
  type ProjectProviderAvailability,
  type ProjectProviderAvailabilityEntry,
  // biome-ignore lint/style/noRestrictedImports: the fixture mirrors the API, which lists every ramp provider the deployment knows
  RAMP_PROVIDERS,
  type RampProviderId,
} from "@sdp/types";

/**
 * Builds a Project's provider availability the way the API returns it: every
 * provider the deployment knows, in family and tuple order, with the listed
 * ones available and the rest unavailable as not entitled. A custody mode the
 * Project's environment does not allow is unavailable as not allowed.
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
    ...CUSTODY_PROVIDERS.map((provider): ProjectProviderAvailabilityEntry => {
      const modes = input.custody.flatMap((entry) =>
        entry.provider === provider ? entry.modes : []
      );
      return {
        family: "custody",
        provider,
        modes,
        unavailableModes: CUSTODY_MODES.filter((mode) => !modes.includes(mode)).map((mode) => ({
          mode,
          reason: isCustodyModeAllowedInEnvironment(input.project.environment, mode)
            ? "provider_not_entitled"
            : "custody_mode_not_allowed",
        })),
      };
    }),
    ...COMPLIANCE_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry =>
        input.compliance.includes(provider)
          ? { family: "compliance", provider, available: true }
          : { family: "compliance", provider, available: false, reason: "provider_not_entitled" }
    ),
    ...RAMP_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry =>
        input.ramps.includes(provider)
          ? { family: "ramps", provider, available: true }
          : { family: "ramps", provider, available: false, reason: "provider_not_entitled" }
    ),
    ...EARN_PROVIDERS.map(
      (provider): ProjectProviderAvailabilityEntry =>
        input.earn.includes(provider)
          ? { family: "earn", provider, available: true }
          : { family: "earn", provider, available: false, reason: "provider_not_entitled" }
    ),
  ];
  return { projectId: input.project.id, environment: input.project.environment, providers };
}
