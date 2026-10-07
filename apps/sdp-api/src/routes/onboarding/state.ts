import type { CustodyProvider } from "@sdp/types";

export const ONBOARDING_VERSION = 1;

export type OrganizationOnboardingSetup = {
  status: "not_started" | "in_progress" | "complete";
  currentStep: "custody" | "complete";
  custodyProvider: CustodyProvider | null;
  completedAt: string | null;
  version: number;
  canManage: boolean;
};

/**
 * Derive an organization's onboarding progress. Custody is the only setup step:
 * it is in progress once the default sandbox custody wallet exists, and
 * complete once setup is finished.
 *
 * @param input - The organization's onboarding facts.
 * @param input.completedAt - When setup was finished, or null while it is open.
 * @param input.custodyProvider - Provider of the default sandbox custody wallet, or null before one exists.
 * @param input.version - Onboarding version the organization is on.
 * @param input.canManage - Whether the caller may finish setup.
 * @returns The onboarding status, current step, and the facts it was derived from.
 */
export function resolveOnboardingSetup(input: {
  completedAt: string | null;
  custodyProvider: CustodyProvider | null;
  version: number;
  canManage: boolean;
}): OrganizationOnboardingSetup {
  if (input.completedAt) {
    return {
      status: "complete",
      currentStep: "complete",
      custodyProvider: input.custodyProvider,
      completedAt: input.completedAt,
      version: input.version,
      canManage: input.canManage,
    };
  }

  return {
    status: input.custodyProvider ? "in_progress" : "not_started",
    currentStep: "custody",
    custodyProvider: input.custodyProvider,
    completedAt: null,
    version: input.version,
    canManage: input.canManage,
  };
}
