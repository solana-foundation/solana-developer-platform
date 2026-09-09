import { advanceQuickStartProgress } from "@sdp/types";
import { cache } from "react";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import type { QuickStartStep } from "./dashboard-quick-start";
import { createOrgSdpApiClient } from "./sdp-api";

export const loadQuickStartStep = cache(async (): Promise<QuickStartStep | null> => {
  try {
    const client = await createOrgSdpApiClient();
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
    if (!status.linked || !status.setup?.canManage) return null;
    if (status.setup.status === "complete") return "done";
    return advanceQuickStartProgress(undefined, status.organization?.settings?.quickStartStep);
  } catch {
    // Unknown is not new: don't flash an onboarding modal on a status failure.
    return null;
  }
});
