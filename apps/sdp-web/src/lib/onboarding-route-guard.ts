export type OrganizationOnboardingStatus = "not_started" | "in_progress" | "complete";

export function shouldRedirectToOrganizationOnboarding(
  status: OrganizationOnboardingStatus | null,
  pathname: string
): boolean {
  const isOnboardingRoute =
    pathname === "/dashboard/onboarding" || pathname.startsWith("/dashboard/onboarding/");
  return status !== null && status !== "complete" && !isOnboardingRoute;
}
