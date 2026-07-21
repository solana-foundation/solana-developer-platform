"use server";

import type { OrganizationRpcProvider } from "@sdp/types";
import { initializeCustodySetupAction } from "@/app/dashboard/custody/actions";
import { updateOrganizationRpcSettingsAction } from "@/app/dashboard/settings/actions";
import { getTranslations } from "@/i18n/server";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

export type OrganizationOnboardingActionResult =
  | { status: "success" }
  | { status: "error"; message: string };

export async function saveOnboardingRpcAction(input: {
  organizationId: string;
  rpcProvider: OrganizationRpcProvider;
}): Promise<OrganizationOnboardingActionResult> {
  const formData = new FormData();
  formData.set("organizationId", input.organizationId);
  formData.set("rpcProvider", input.rpcProvider);
  const result = await updateOrganizationRpcSettingsAction(formData);
  return result.status === "success"
    ? { status: "success" }
    : { status: "error", message: result.message };
}

export async function completeOrganizationOnboardingAction(
  provider: string
): Promise<OrganizationOnboardingActionResult> {
  const t = await getTranslations();
  const formData = new FormData();
  formData.set("provider", provider);
  formData.set("walletLabel", "Default wallet");
  const walletResult = await initializeCustodySetupAction(formData);
  if (walletResult.status === "error") {
    return walletResult;
  }

  try {
    const client = await createOrgSdpApiClient();
    await client.fetch("/v1/onboarding/complete", { method: "POST", body: "{}" });
    return { status: "success" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : t("DashboardCustody.onboardingFinishError"),
    };
  }
}
