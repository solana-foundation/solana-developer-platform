"use client";

import { Button } from "@/components/ui/button";
import { ProviderSelectionCard } from "@/components/ui/provider-selection-card";
import { useTranslations } from "@/i18n/provider";
import {
  type KnownCustodyProvider,
  WALLET_PROVIDER_CATEGORIES,
  WALLET_PROVIDER_CATEGORY_DETAILS,
} from "./provider-catalog";
import type { CustodyProviderAvailability } from "./provider-display-status";
import { WalletProviderMark } from "./wallet-provider-mark";

export function WalletProviderChoices({
  availability,
  canSelect = true,
  grouped = true,
  onSelect,
  selectedProvider,
}: {
  availability: CustodyProviderAvailability[];
  canSelect?: boolean;
  grouped?: boolean;
  onSelect: (provider: KnownCustodyProvider) => void;
  selectedProvider: KnownCustodyProvider | null;
}) {
  const t = useTranslations();
  const hasSelectableProvider = availability.some((provider) => provider.isSelectable);
  const categories = grouped ? WALLET_PROVIDER_CATEGORIES : [null];

  return (
    <div className="grid gap-8">
      {!canSelect || hasSelectableProvider ? null : (
        <p
          role="status"
          className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
        >
          {t("DashboardCustody.walletCreationAvailable")}
        </p>
      )}

      {categories.map((category) => {
        const providers = category
          ? availability.filter((provider) => provider.entry.category === category)
          : availability;
        if (providers.length === 0) {
          return null;
        }
        const details = category ? WALLET_PROVIDER_CATEGORY_DETAILS[category] : null;

        return (
          <section key={category ?? "all"} className="grid gap-4">
            {details ? (
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-primary">{t(details.labelKey)}</h3>
                <p className="text-sm leading-5 text-tertiary">{t(details.descriptionKey)}</p>
              </div>
            ) : null}

            {providers.map((provider) => {
              const isSelected = selectedProvider === provider.entry.id;

              return (
                <ProviderSelectionCard
                  key={provider.entry.id}
                  onSelect={() => onSelect(provider.entry.id)}
                  isSelected={isSelected}
                  isSelectable={canSelect && provider.isSelectable}
                  advanceOnEnter={isSelected}
                  icon={<WalletProviderMark provider={provider.entry.id} size="sm" />}
                  title={provider.entry.label}
                  description={t(provider.entry.descriptionKey)}
                  badge={
                    provider.status === "active" ? (
                      <span className="rounded-full bg-surface-raised px-3 py-1 text-xs font-medium text-secondary ring-1 ring-border-subtle">
                        {t("DashboardCustody.active")}
                      </span>
                    ) : provider.status === "request_access" ? (
                      // Visible but not self-serve installable (HOO-772): the
                      // pill says why the card cannot be selected.
                      <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
                        {t("Shared.integrations.statusRequestAccess")}
                      </span>
                    ) : provider.status === "not_configured" ? (
                      <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-tertiary">
                        {t("Shared.integrations.statusNotConfigured")}
                      </span>
                    ) : undefined
                  }
                  action={
                    canSelect && provider.requestAccessUrl ? (
                      <Button asChild variant="secondary">
                        <a
                          href={provider.requestAccessUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {t("DashboardCustody.providerRequestAccess")}
                        </a>
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
