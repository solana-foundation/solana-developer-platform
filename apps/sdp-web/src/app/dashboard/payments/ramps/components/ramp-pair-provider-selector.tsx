"use client";

import type { Counterparty, CounterpartyEntityType, PaymentsDashboardWallet } from "@sdp/types";
import {
  RAMP_PROVIDER_SUPPORT_DETAILS,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp-support";
import {
  type CryptoRailId,
  countryDisplayName,
  getCryptoRailAssetLabel,
  type RampProviderDirectionSupport,
  rampProviderServesCountry,
} from "@sdp/types/payment-rails";
import type { ProviderAvailabilityEntry, RampProviderId } from "@sdp/types/provider-access";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import type { RampProviderAccess } from "@/lib/provider-availability";
import {
  findRampPair,
  OFFRAMP_PAIRS,
  ONRAMP_PAIRS,
  RAMP_PROVIDER_LOGOS,
  RAMP_PROVIDER_OPTIONS,
  type RampDirection,
  type RampPair,
  type RampProviderOption,
  rampPairKey,
  type SelectedRampPair,
} from "@/lib/ramps";
import { useRampEstimate } from "../hooks/use-ramp-estimate";
import { CurrencyPairSelector } from "./currency-pair-selector";
import { ProviderCard } from "./provider-card";
import { RampSelectionProvider } from "./ramp-selection-context";

interface RampPairProviderSelectorProps {
  direction: RampDirection;
  rampProviderAccess: RampProviderAccess | null;
  selectedCounterparty: Counterparty | null;
  wallets: readonly PaymentsDashboardWallet[];
  walletsLoading: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  showWallet: boolean;
  selectedPair: SelectedRampPair;
  selectedProvider: RampProviderId | null;
  amount: string;
  onAmountChange: (amount: string) => void;
  onAmountBlur: () => void;
  onWalletChange: (walletId: string) => void;
  onPairChange: (pair: SelectedRampPair) => void;
  onProviderSelect: (provider: RampProviderId) => void;
}

interface ProviderExclusion {
  option: RampProviderOption;
  reasons: readonly string[];
}

const entityTypeListFormatter = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

function getDirectionSupport(
  provider: RampProviderId,
  direction: RampDirection
): RampProviderDirectionSupport {
  return RAMP_PROVIDER_SUPPORT_DETAILS[provider][direction];
}

function pairsForDirection(direction: RampDirection): readonly RampPair[] {
  switch (direction) {
    case "onramp":
      return ONRAMP_PAIRS;
    case "offramp":
      return OFFRAMP_PAIRS;
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

function getCounterpartyCountry(counterparty: Counterparty | null): string | null {
  if (counterparty === null) {
    return null;
  }
  return counterparty.identity.address.countryCode;
}

function providerAccessReason(access: ProviderAvailabilityEntry): string | null {
  if (!access.entitled) {
    return "Not available on your plan";
  }
  if (!access.configured) {
    return "Provider credentials are not configured for this environment";
  }
  if (!access.enabled) {
    return "Disabled for this organization";
  }
  return null;
}

function unsupportedPairReason(direction: RampDirection, selectedPair: SelectedRampPair): string {
  const assetLabel = getCryptoRailAssetLabel(selectedPair.assetRail);
  switch (direction) {
    case "onramp":
      return `Does not support ${selectedPair.fiatCurrency} → ${assetLabel}`;
    case "offramp":
      return `Does not support ${assetLabel} → ${selectedPair.fiatCurrency}`;
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

function formatEntityTypes(entityTypes: readonly CounterpartyEntityType[]): string {
  return entityTypeListFormatter.format(entityTypes);
}

/**
 * Off-ramp amount input is crypto-denominated while generated provider limits
 * are fiat-denominated, so limit exclusion reasons only apply to on-ramp.
 */
function amountLimitReasons(
  direction: RampDirection,
  support: RampProviderDirectionSupport,
  fiatCurrency: RampFiatCurrency,
  amount: string
): readonly string[] {
  if (direction === "offramp") {
    return [];
  }

  const parsedAmount = Number(amount.trim());
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return [];
  }

  const limits = support.currencies[fiatCurrency];
  if (limits === undefined) {
    return [];
  }

  const reasons: string[] = [];
  if (limits.min !== null && parsedAmount < Number(limits.min)) {
    reasons.push(`Minimum is ${limits.min} ${fiatCurrency}`);
  }
  if (limits.max !== null && parsedAmount > Number(limits.max)) {
    reasons.push(`Maximum is ${limits.max} ${fiatCurrency}`);
  }
  return reasons;
}

function buildProviderExclusion(args: {
  option: RampProviderOption;
  direction: RampDirection;
  rampProviderAccess: RampProviderAccess | null;
  selectedPairSupport: RampPair | null;
  selectedPair: SelectedRampPair;
  selectedCounterparty: Counterparty | null;
  selectedCountry: string | null;
  amount: string;
}): ProviderExclusion | null {
  const {
    option,
    direction,
    rampProviderAccess,
    selectedPairSupport,
    selectedPair,
    selectedCounterparty,
    selectedCountry,
    amount,
  } = args;
  const provider = option.id;
  const reasons: string[] = [];
  const support = getDirectionSupport(provider, direction);

  if (rampProviderAccess !== null) {
    const access = rampProviderAccess[provider];
    if (access === undefined) {
      reasons.push("Availability is not reported for this environment");
    } else {
      const reason = providerAccessReason(access);
      if (reason !== null) {
        reasons.push(reason);
      }
    }
  }

  if (selectedPairSupport === null || !selectedPairSupport.providers.includes(provider)) {
    reasons.push(unsupportedPairReason(direction, selectedPair));
  }

  if (selectedCountry !== null) {
    const countryServed = rampProviderServesCountry(
      support.countrySupport,
      selectedCountry,
      selectedPair.fiatCurrency
    );
    if (countryServed === false) {
      reasons.push(`Not available in ${countryDisplayName(selectedCountry)}`);
    }
  }

  if (selectedCounterparty !== null && support.entityTypes.length > 0) {
    if (!support.entityTypes.includes(selectedCounterparty.entityType)) {
      reasons.push(`Supports ${formatEntityTypes(support.entityTypes)} counterparties only`);
    }
  }

  reasons.push(...amountLimitReasons(direction, support, selectedPair.fiatCurrency, amount));

  if (reasons.length === 0) {
    return null;
  }

  return { option, reasons };
}

export function RampPairProviderSelector({
  direction,
  rampProviderAccess,
  selectedCounterparty,
  wallets,
  walletsLoading,
  selectedWallet,
  showWallet,
  selectedPair,
  selectedProvider,
  amount,
  onAmountChange,
  onAmountBlur,
  onWalletChange,
  onPairChange,
  onProviderSelect,
}: RampPairProviderSelectorProps) {
  const t = useTranslations();
  const [unavailableDialogOpen, setUnavailableDialogOpen] = useState(false);
  const pairs = pairsForDirection(direction);
  const selectedPairSupport = useMemo(
    () => findRampPair(pairs, selectedPair),
    [pairs, selectedPair]
  );
  const selectedCountry = useMemo(
    () => getCounterpartyCountry(selectedCounterparty),
    [selectedCounterparty]
  );
  const directionProviderOptions = useMemo(
    () =>
      RAMP_PROVIDER_OPTIONS.filter(
        (option) => Object.keys(getDirectionSupport(option.id, direction).currencies).length > 0
      ),
    [direction]
  );
  const providerExclusions = useMemo(
    () =>
      directionProviderOptions.flatMap((option) => {
        const exclusion = buildProviderExclusion({
          option,
          direction,
          rampProviderAccess,
          selectedPairSupport,
          selectedPair,
          selectedCounterparty,
          selectedCountry,
          amount,
        });
        return exclusion ? [exclusion] : [];
      }),
    [
      amount,
      direction,
      directionProviderOptions,
      rampProviderAccess,
      selectedCounterparty,
      selectedCountry,
      selectedPair,
      selectedPairSupport,
    ]
  );
  const excludedProviderSet = useMemo(
    () => new Set(providerExclusions.map((exclusion) => exclusion.option.id)),
    [providerExclusions]
  );
  const availableProviders = useMemo(
    () => directionProviderOptions.filter((option) => !excludedProviderSet.has(option.id)),
    [directionProviderOptions, excludedProviderSet]
  );
  const { estimatesByProvider, loading: estimatesLoading } = useRampEstimate({
    direction,
    selectedPair,
    amount,
    enabled: availableProviders.length > 0,
  });
  const pairByKey = useMemo(() => {
    const nextPairs = new Map<string, SelectedRampPair>();
    for (const pair of pairs) {
      nextPairs.set(rampPairKey(pair), {
        fiatCurrency: pair.fiatCurrency,
        assetRail: pair.assetRail,
      });
    }
    return nextPairs;
  }, [pairs]);
  const fiatCurrencies = useMemo(() => {
    const currencies = new Set<RampFiatCurrency>();
    for (const pair of pairs) {
      currencies.add(pair.fiatCurrency);
    }
    return [...currencies].sort();
  }, [pairs]);
  const assetRailsForFiat = useMemo(() => {
    const assetRails = new Set<CryptoRailId>();
    for (const pair of pairs) {
      if (pair.fiatCurrency === selectedPair.fiatCurrency) {
        assetRails.add(pair.assetRail);
      }
    }
    return [...assetRails].sort((left, right) =>
      getCryptoRailAssetLabel(left).localeCompare(getCryptoRailAssetLabel(right))
    );
  }, [pairs, selectedPair.fiatCurrency]);

  const selectFiatCurrency = useCallback(
    (fiatCurrency: RampFiatCurrency) => {
      const currentAssetPair = pairByKey.get(
        rampPairKey({ fiatCurrency, assetRail: selectedPair.assetRail })
      );
      if (currentAssetPair) {
        onPairChange(currentAssetPair);
        return;
      }

      const fallback = pairs.find((pair) => pair.fiatCurrency === fiatCurrency);
      if (fallback) {
        onPairChange({ fiatCurrency: fallback.fiatCurrency, assetRail: fallback.assetRail });
      }
    },
    [onPairChange, pairByKey, pairs, selectedPair.assetRail]
  );

  const selectAssetRail = useCallback(
    (assetRail: CryptoRailId) => {
      const nextPair = pairByKey.get(
        rampPairKey({ fiatCurrency: selectedPair.fiatCurrency, assetRail })
      );
      if (nextPair) {
        onPairChange(nextPair);
      }
    },
    [onPairChange, pairByKey, selectedPair.fiatCurrency]
  );
  const selectionContextValue = useMemo(
    () => ({
      direction,
      fiatCurrencies,
      assetRails: assetRailsForFiat,
      wallets,
      walletsLoading,
      selectedWallet,
      showWallet,
      selectedPair,
      amount,
      onAmountChange,
      onAmountBlur,
      onWalletChange,
      onFiatCurrencyChange: selectFiatCurrency,
      onAssetRailChange: selectAssetRail,
    }),
    [
      amount,
      assetRailsForFiat,
      direction,
      fiatCurrencies,
      onAmountBlur,
      onAmountChange,
      onWalletChange,
      selectAssetRail,
      selectFiatCurrency,
      selectedPair,
      selectedWallet,
      showWallet,
      wallets,
      walletsLoading,
    ]
  );

  return (
    <div className="space-y-7">
      <RampSelectionProvider value={selectionContextValue}>
        <div className="flex flex-col gap-2">
          <CurrencyPairSelector />
        </div>
      </RampSelectionProvider>

      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <p className="shrink-0 text-xl font-medium text-text-extra-high">
            {t("DashboardPayments.ramps.chooseProvider")}
          </p>
          {providerExclusions.length > 0 ? (
            <button
              type="button"
              onClick={() => setUnavailableDialogOpen(true)}
              className="rounded-full bg-border-extra-light px-2 py-0.5 text-xs leading-none font-medium text-text-low transition-colors hover:bg-border-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-low focus-visible:ring-offset-2"
            >
              {t("DashboardPayments.ramps.unavailableCount", {
                count: providerExclusions.length,
              })}
            </button>
          ) : null}
          <div className="h-px flex-1 bg-border-light" />
        </div>

        <div className="-mx-1.5 h-96 overflow-y-auto px-1.5 py-1">
          <motion.div layout className="space-y-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {availableProviders.map((option) => (
                <ProviderCard
                  key={option.id}
                  option={option}
                  active={selectedProvider === option.id}
                  estimate={estimatesByProvider.get(option.id)}
                  estimateLoading={estimatesLoading}
                  onSelect={() => onProviderSelect(option.id)}
                />
              ))}
            </AnimatePresence>

            {availableProviders.length === 0 ? (
              <motion.p
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-2 text-sm text-text-low"
              >
                {t("DashboardPayments.ramps.noProvidersAvailable")}
              </motion.p>
            ) : null}
          </motion.div>
        </div>
      </div>

      <Modal
        isOpen={unavailableDialogOpen && providerExclusions.length > 0}
        onClose={() => setUnavailableDialogOpen(false)}
        ariaLabel={t("DashboardPayments.ramps.unavailableProviders")}
        size="md"
      >
        <div className="px-5 py-5">
          <h2 className="pr-10 text-lg font-medium text-text-extra-high">
            {t("DashboardPayments.ramps.unavailableProviders")}
          </h2>
          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
            {providerExclusions.map((exclusion) => (
              <div
                key={exclusion.option.id}
                className="rounded-xl border border-border-light bg-border-extra-light p-3"
              >
                <div className="flex items-start gap-3">
                  <Image
                    src={RAMP_PROVIDER_LOGOS[exclusion.option.id]}
                    alt=""
                    width={32}
                    height={32}
                    className="size-8 shrink-0 rounded-lg object-contain"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-extra-high">
                      {exclusion.option.title}
                    </p>
                    <div className="mt-2 space-y-1 text-sm text-text-low">
                      {exclusion.reasons.map((reason) => (
                        <p key={reason}>{reason}</p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
