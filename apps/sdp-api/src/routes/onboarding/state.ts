import type { CustodyProvider, OrganizationRpcProvider } from "@sdp/types";

export const ONBOARDING_VERSION = 1;

export type OrganizationOnboardingSetup = {
  status: "not_started" | "in_progress" | "complete";
  currentStep: "rpc" | "custody" | "complete";
  rpcProvider: OrganizationRpcProvider | null;
  custodyProvider: CustodyProvider | null;
  completedAt: string | null;
  version: number;
  canManage: boolean;
};

export function resolveOnboardingSetup(input: {
  completedAt: string | null;
  rpcProvider: OrganizationRpcProvider | null;
  custodyProvider: CustodyProvider | null;
  version: number;
  canManage: boolean;
}): OrganizationOnboardingSetup {
  if (input.completedAt) {
    return {
      status: "complete",
      currentStep: "complete",
      rpcProvider: input.rpcProvider,
      custodyProvider: input.custodyProvider,
      completedAt: input.completedAt,
      version: input.version,
      canManage: input.canManage,
    };
  }

  return {
    status: input.rpcProvider ? "in_progress" : "not_started",
    currentStep: input.rpcProvider ? "custody" : "rpc",
    rpcProvider: input.rpcProvider,
    custodyProvider: input.custodyProvider,
    completedAt: null,
    version: input.version,
    canManage: input.canManage,
  };
}
