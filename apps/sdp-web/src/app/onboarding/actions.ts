"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sdpApiFetch } from "@/lib/sdp-api";

export interface OnboardingStatus {
  linked: boolean;
  organization: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return sdpApiFetch<OnboardingStatus>("/v1/onboarding/status");
}

export async function linkOrganization(formData?: FormData) {
  const returnTo = formData?.get("returnTo");
  const redirectTo = returnTo ? String(returnTo) : null;

  await linkOrganizationSilently();

  revalidatePath("/");
  revalidatePath("/allowlist");
  revalidatePath("/members");

  if (redirectTo) {
    redirect(redirectTo);
  }
}

export async function linkOrganizationSilently() {
  await sdpApiFetch("/v1/onboarding/link-org", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
