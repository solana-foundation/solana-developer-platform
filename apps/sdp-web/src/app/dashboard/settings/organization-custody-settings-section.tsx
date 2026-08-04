"use client";

import { CUSTODY_PROVIDER_CATALOG_BY_ID, type CustodyConfigSummary } from "@sdp/types";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * Custody providers, alongside the RPC selector that already lives in Settings.
 *
 * Onboarding tells every organization it can manage providers in Settings. The
 * custody capability was real but lived at the wallet setup route, so Settings
 * delivered RPC only and the promise read as false.
 *
 * Deliberately "connect another" rather than "change": onboarding provisions a
 * wallet on the provider chosen there, and adding a second config does not migrate
 * it. The copy says so instead of implying a switch that does not exist.
 */
export function OrganizationCustodySettingsSection({
  configs,
}: {
  configs: CustodyConfigSummary[];
}) {
  const t = useTranslations();
  const active = configs.filter((entry) => entry.status === "active");

  return (
    <div className="w-full space-y-3">
      <div className="space-y-1">
        <h3 className="text-[15px] font-medium text-primary">
          {t("DashboardCustody.settingsCustodyTitle")}
        </h3>
        <p className="text-sm text-tertiary">{t("DashboardCustody.settingsCustodyDescription")}</p>
      </div>

      {active.length === 0 ? (
        <p className="text-sm text-secondary">{t("DashboardCustody.settingsCustodyEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {active.map((entry) => (
            <li key={entry.id} className="flex min-w-0 items-center gap-3">
              <WalletProviderMark provider={entry.provider} size="sm" />
              <span className="min-w-0 truncate text-[15px] font-medium text-primary">
                {CUSTODY_PROVIDER_CATALOG_BY_ID[entry.provider]?.label ?? entry.provider}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Button asChild variant="secondary">
        <DashboardNavigationLink href="/dashboard/wallets/setup">
          {t("DashboardCustody.settingsCustodyConnect")}
        </DashboardNavigationLink>
      </Button>
    </div>
  );
}
