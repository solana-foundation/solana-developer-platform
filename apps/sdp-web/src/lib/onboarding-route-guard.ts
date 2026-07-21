export type OrganizationOnboardingStatus = "not_started" | "in_progress" | "complete";

export function shouldRedirectToOrganizationOnboarding(
  status: OrganizationOnboardingStatus | null,
  pathname: string
): boolean {
  return status !== null && status !== "complete" && pathname !== "/dashboard/onboarding";
}
