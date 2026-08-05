"use client";

import type { CustodyProvider } from "@sdp/types";
import type { OnboardingProvisionedWallet } from "@/app/dashboard/custody/actions";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/dashboard/custody/provider-catalog";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * The end of setup, which used to be a silent redirect.
 *
 * Onboarding provisions a real wallet. Sending the user straight to the
 * dashboard spent that moment without ever naming what had been created, so a
 * first run finished with no evidence anything had happened.
 */
export function OnboardingCompletePanel({
  provider,
  wallet,
}: {
  provider: CustodyProvider;
  wallet: OnboardingProvisionedWallet | null;
}) {
  const t = useTranslations();
  const providerLabel = CUSTODY_PROVIDER_CATALOG.find((entry) => entry.id === provider)?.label;

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-6">
      <div
        className="w-full max-w-xl rounded-2xl border border-border-default bg-surface-raised p-8"
        data-organization-onboarding-complete="true"
      >
        <h1 className="text-2xl font-medium tracking-tight text-primary">
          {t("DashboardCustody.onboardingDoneTitle")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-tertiary">
          {t("DashboardCustody.onboardingDoneBody", { provider: providerLabel ?? "" })}
        </p>

        {wallet ? (
          <div className="mt-6 rounded-2xl border border-border-subtle bg-fill-subtle px-5 py-4">
            <p className="text-xs font-medium tracking-wide text-tertiary uppercase">
              {t("DashboardCustody.onboardingDoneWalletHeading")}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 truncate font-mono text-sm text-primary">
                {wallet.publicKey}
              </code>
              <WalletMetadataCopyButton
                value={wallet.publicKey}
                label={t("DashboardCustody.onboardingDoneWalletHeading")}
              />
            </div>
          </div>
        ) : (
          <p className="mt-6 rounded-2xl border border-border-subtle bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary">
            {t("DashboardCustody.onboardingDoneWalletPending")}
          </p>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button asChild>
            <DashboardNavigationLink href="/dashboard">
              {t("DashboardCustody.onboardingDoneGoToDashboard")}
            </DashboardNavigationLink>
          </Button>
          <Button asChild variant="secondary">
            <DashboardNavigationLink href="/dashboard/wallets">
              {t("DashboardCustody.onboardingDoneViewWallets")}
            </DashboardNavigationLink>
          </Button>
        </div>
      </div>
    </div>
  );
}
