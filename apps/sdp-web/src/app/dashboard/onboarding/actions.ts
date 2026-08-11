"use server";

import type { CustodyProvider, OrganizationRpcProvider } from "@sdp/types";
import {
  initializeOnboardingCustodyAction,
  type OnboardingProvisionedWallet,
} from "@/app/dashboard/custody/actions";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import { updateOrganizationRpcSettingsAction } from "@/app/dashboard/settings/actions";
import { getTranslations } from "@/i18n/server";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

export type OrganizationOnboardingActionResult =
  | { status: "success" }
  | { status: "error"; message: string };

/** Completion carries the wallet it provisioned so the wizard can show it. */
export type OrganizationOnboardingCompletionResult =
  | { status: "success"; wallet: OnboardingProvisionedWallet }
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

export async function completeOrganizationOnboardingAction(input: {
  custodyProvider: CustodyProvider;
  useDefaultRpc: boolean;
}): Promise<OrganizationOnboardingCompletionResult> {
  const t = await getTranslations();
  try {
    const client = await createOrgSdpApiClient();
    if (input.useDefaultRpc) {
      const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
      if (!status.organization || !status.setup) {
        return {
          status: "error",
          message: t("DashboardCustody.onboardingFinishError"),
        };
      }
      if (status.setup.rpcProvider === null) {
        const rpcResult = await saveOnboardingRpcAction({
          organizationId: status.organization.id,
          rpcProvider: "default",
        });
        if (rpcResult.status === "error") {
          return rpcResult;
        }
      }
    }

    const formData = new FormData();
    formData.set("provider", input.custodyProvider);
    formData.set("walletLabel", t("DashboardCustody.onboardingDefaultWalletLabel"));
    const walletResult = await initializeOnboardingCustodyAction(formData);
    if (walletResult.status === "error") {
      return walletResult;
    }

    await client.fetch("/v1/onboarding/complete", {
      method: "POST",
      body: JSON.stringify({ custodyProvider: input.custodyProvider }),
    });
    // Deliberately no layout revalidation here: it re-renders the onboarding
    // route mid-transition, and that page redirects once setup is complete,
    // killing the completion panel before it paints. The panel's exits are
    // full document navigations, so every server boundary is fresh on the way
    // out without it.
    return { status: "success", wallet: walletResult.wallet };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : t("DashboardCustody.onboardingFinishError"),
    };
  }
}
