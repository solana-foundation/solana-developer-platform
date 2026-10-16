import type { CustodyProvider, OrganizationOnboardingSetup } from "@sdp/types";

export const ONBOARDING_VERSION = 1;

/**
 * Derive an organization's onboarding progress. Custody is the only setup step:
 * it is in progress once the default sandbox project has any custody backend,
 * and complete once setup is finished.
 *
 * @param input - The organization's onboarding facts.
 * @param input.completedAt - When setup was finished, or null while it is open.
 * @param input.custodyProviders - Providers with an active config or connection in the default sandbox project.
 * @param input.version - Onboarding version the organization is on.
 * @param input.canManage - Whether the caller may finish setup.
 * @returns The onboarding status, current step, and the facts it was derived from.
 */
export function resolveOnboardingSetup(input: {
  completedAt: string | null;
  custodyProviders: CustodyProvider[];
  version: number;
  canManage: boolean;
}): OrganizationOnboardingSetup {
  if (input.completedAt) {
    return {
      status: "complete",
      currentStep: "complete",
      custodyProviders: input.custodyProviders,
      completedAt: input.completedAt,
      version: input.version,
      canManage: input.canManage,
    };
  }

  return {
    status: input.custodyProviders.length > 0 ? "in_progress" : "not_started",
    currentStep: "custody",
    custodyProviders: input.custodyProviders,
    completedAt: null,
    version: input.version,
    canManage: input.canManage,
  };
}
