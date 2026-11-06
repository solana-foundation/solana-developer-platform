import type { OrganizationOnboardingSetup } from "@sdp/types/organizations";

export type OnboardingStatusResponse = {
  linked: boolean;
  organization: {
    id: string;
  } | null;
  setup?: OrganizationOnboardingSetup | null;
};
