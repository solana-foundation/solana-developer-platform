export type OnboardingStatusResponse = {
  linked: boolean;
  organization: {
    id: string;
  } | null;
  setup?: {
    status: "incomplete" | "complete";
    currentStep: "rpc" | "custody" | "complete";
    rpcProvider: import("@sdp/types").OrganizationRpcProvider | null;
    custodyProvider: import("@sdp/types").CustodyProvider | null;
    completedAt: string | null;
    version: number;
    canManage: boolean;
  } | null;
};
