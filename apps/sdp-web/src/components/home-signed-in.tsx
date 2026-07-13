"use client";

import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";
import { AutoDashboardRedirect } from "@/components/redirects";
import { useTranslations } from "@/i18n/provider";

export function HomeSignedInCard() {
  const { isLoaded, orgId } = useAuth();
  const t = useTranslations();

  if (!isLoaded) {
    return <p className="text-sm text-secondary">{t("Shared.homeSignedIn.loading")}</p>;
  }

  if (!orgId) {
    return (
      <div className="rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-6 shadow-sm">
        <h2 className="text-[19px] leading-6 font-medium text-primary">
          {t("Shared.homeSignedIn.selectOrganization")}
        </h2>
        <p className="mt-3 text-sm text-secondary">
          {t("Shared.homeSignedIn.selectOrganizationDescription")}
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-6 shadow-sm">
      <AutoDashboardRedirect />
      <p className="text-sm text-secondary">{t("Shared.homeSignedIn.loadingDashboard")}</p>
    </div>
  );
}
