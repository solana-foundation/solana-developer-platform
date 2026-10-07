export type OnboardingStatusResponse = {
  linked: boolean;
  organization: {
    id: string;
  } | null;
  setup?: {
    status: "not_started" | "in_progress" | "complete";
    currentStep: "custody" | "complete";
    custodyProvider: import("@sdp/types").CustodyProvider | null;
    completedAt: string | null;
    version: number;
    canManage: boolean;
  } | null;
};
