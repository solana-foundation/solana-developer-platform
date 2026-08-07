"use client";

import { OrganizationSwitcher } from "@clerk/nextjs";
import { useTranslations } from "@/i18n/provider";

/**
 * What a member who cannot run setup can actually do from here.
 *
 * Every dashboard route is closed to them: `shouldRedirectToOrganizationOnboarding`
 * returns true for any path outside `/dashboard/onboarding` while setup is
 * incomplete, and the shell acts on it with a `router.replace`. So an in-app link
 * is not a way out — it lands back on this card. Settings in particular also hides
 * the members list unless the viewer can manage organization settings, so it could
 * not have named an admin either.
 *
 * Switching organization is the one move that genuinely changes their situation,
 * and the switcher doubles as a way to create an organization they would own. Same
 * component the no-active-organization panel uses.
 */
export function OnboardingBlockedActions() {
  const t = useTranslations();

  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <p className="text-xs text-tertiary">{t("DashboardCustody.onboardingAdminSwitchHint")}</p>
      <OrganizationSwitcher hidePersonal />
    </div>
  );
}
