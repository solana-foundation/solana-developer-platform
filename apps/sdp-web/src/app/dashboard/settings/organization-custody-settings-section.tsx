"use client";

import { CUSTODY_PROVIDER_CATALOG_BY_ID, type CustodyConfigSummary } from "@sdp/types";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * Custody providers, beside the RPC selector that already lives in Settings.
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
    // Mirrors the RPC field above it: a `grid gap-2` block led by the same
    // `text-sm font-medium` label, so the two settings read as one column rather
    // than a styled control followed by loose prose.
    <div className="grid gap-2">
      <span className="text-sm font-medium text-primary">
        {t("DashboardCustody.settingsCustodyTitle")}
      </span>
      <p className="text-sm text-tertiary">{t("DashboardCustody.settingsCustodyDescription")}</p>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        {active.length === 0 ? (
          <div className="flex h-10 w-full items-center rounded-xl border border-border-default bg-fill-subtle px-3 text-sm text-secondary">
            {t("DashboardCustody.settingsCustodyEmpty")}
          </div>
        ) : (
          <ul className="grid gap-2">
            {active.map((entry) => (
              <li
                key={entry.id}
                className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-border-default bg-fill-subtle px-3"
              >
                <WalletProviderMark provider={entry.provider} size="sm" />
                <span className="min-w-0 truncate text-sm font-medium text-primary">
                  {CUSTODY_PROVIDER_CATALOG_BY_ID[entry.provider]?.label ?? entry.provider}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button asChild variant="secondary" className="w-full sm:w-auto sm:justify-center">
          <DashboardNavigationLink href="/dashboard/wallets/setup">
            {t("DashboardCustody.settingsCustodyConnect")}
          </DashboardNavigationLink>
        </Button>
      </div>
    </div>
  );
}
