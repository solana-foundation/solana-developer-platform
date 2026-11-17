"use client";

import { OrganizationSwitcher, useClerk } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { useTranslations } from "@/i18n/provider";

/** The mainnet request page's way out: another organization of the user's, or signing out. */
export function MainnetAccessAccountActions() {
  const t = useTranslations();
  const { signOut } = useClerk();
  return (
    <div className="flex items-center gap-2">
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/dashboard"
        afterCreateOrganizationUrl="/dashboard"
      />
      <Button variant="ghost" size="sm" onClick={() => void signOut({ redirectUrl: "/" })}>
        {t("Shared.dashboardShell.signOut")}
      </Button>
    </div>
  );
}
