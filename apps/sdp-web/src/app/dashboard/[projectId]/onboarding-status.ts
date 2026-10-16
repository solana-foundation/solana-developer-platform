import type { OrganizationOnboardingSetup } from "@sdp/types";

export type OnboardingStatusResponse = {
  linked: boolean;
  organization: {
    id: string;
  } | null;
  setup?: OrganizationOnboardingSetup | null;
};
