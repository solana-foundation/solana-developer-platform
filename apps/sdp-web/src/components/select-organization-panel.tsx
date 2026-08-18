"use client";

import { OrganizationSwitcher } from "@clerk/nextjs";
import { useTranslations } from "@/i18n/provider";

/**
 * Fullscreen prompt shown to a signed-in session with no active Clerk
 * organization, letting the user select or create one before the dashboard
 * loads. Rendered by the dashboard server layout when `orgId` is missing and
 * by the shell when the active organization is cleared mid-session.
 *
 * @returns The organization selection panel.
 */
export function SelectOrganizationPanel() {
  const t = useTranslations();

  return (
    <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
      <div className="mx-auto max-w-3xl border border-border-subtle bg-surface-raised/70 p-6">
        <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
          {t("Shared.dashboardShell.selectOrganization")}
        </h1>
        <p className="mt-3 text-sm text-tertiary">
          {t("Shared.dashboardShell.selectOrganizationDescription")}
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </div>
    </main>
  );
}
