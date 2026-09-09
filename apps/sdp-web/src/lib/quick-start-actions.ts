"use server";

import { DASHBOARD_QUICK_START_STEPS } from "@sdp/types";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import type { QuickStartStep } from "./dashboard-quick-start";
import { createOrgSdpApiClient, getSdpAuth } from "./sdp-api";

export async function saveQuickStartProgress(
  expectedOrgId: string,
  step: QuickStartStep
): Promise<boolean> {
  if (!DASHBOARD_QUICK_START_STEPS.includes(step)) return false;
  try {
    const { orgId, orgRole } = await getSdpAuth();
    // An in-flight callback from the old workspace must never write into the new one.
    if (orgId !== expectedOrgId || !["org:admin", "admin"].includes(orgRole ?? "")) return false;
    const client = await createOrgSdpApiClient();
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
    if (!status.organization) return false;
    if (
      status.setup?.status === "complete" ||
      status.organization.settings?.quickStartStep === "done"
    )
      return true;
    await client.fetch(`/v1/organizations/${encodeURIComponent(status.organization.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ settings: { quickStartStep: step } }),
    });
    return true;
  } catch {
    return false;
  }
}
