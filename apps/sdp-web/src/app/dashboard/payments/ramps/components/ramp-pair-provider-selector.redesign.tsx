"use client";

import type {
  Counterparty,
  PaymentsDashboardWallet,
  RampProviderEstimateResult,
  RampProviderId,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { RAMP_PROVIDER_SURFACING } from "@sdp/types/provider-access";
import { AnimatePresence, domMax, LazyMotion, m } from "motion/react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { useThemeScope } from "@/components/theme-scope";
import { Modal } from "@/components/ui/modal";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { RampProviderAccess } from "@/lib/provider-availability";
import {
  findRampPair,
  offrampPairs,
  onrampPairs,
  RAMP_PROVIDER_LOGOS,
  type RampDirection,
  type RampPair,
  type RampProviderOption,
  rampPairKey,
  type SelectedRampPair,
  surfacedRampProviderOptions,
} from "@/lib/ramps";
import { useRampEstimate } from "../hooks/use-ramp-estimate";
import { CurrencyPairSelector } from "./currency-pair-selector.redesign";
import { ProviderCard, ProviderQuoteCard } from "./provider-card.redesign";
import {
  buildProviderExclusion,
  getDirectionSupport,
  type ProviderExclusion,
} from "./provider-exclusions.redesign";
import { RampSelectionProvider } from "./ramp-selection-context";

interface RampPairProviderSelectorProps {
  direction: RampDirection;
  enabledRampProviders: readonly RampProviderId[];
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

/**
 * Returns the available ramp pairs for a direction.
 *
 * @param direction - The ramp direction.
 * @param environment - The dashboard environment.
 * @param enabledRampProviders - The providers enabled for the current request.
 * @returns The available ramp pairs.
 */
function pairsForDirection(
  direction: RampDirection,
  environment: SdpEnvironment,
  enabledRampProviders: readonly RampProviderId[]
): readonly RampPair[] {
  switch (direction) {
    case "onramp":
      return onrampPairs(environment, enabledRampProviders);
    case "offramp":
      return offrampPairs(environment, enabledRampProviders);
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

/**
 * Which providers can take this ramp and which cannot. A provider is out, with its reasons,
 * when its access, the pair, the counterparty's kind or the amount's limits rule it out.
 */
function useProviderAvailability({
  direction,
  sdpEnvironment,
  enabledRampProviders,
  rampProviderAccess,
  selectedPairSupport,
  selectedPair,
  selectedCounterparty,
  amount,
}: {
  direction: RampDirection;
  sdpEnvironment: SdpEnvironment;
  enabledRampProviders: readonly RampProviderId[];
  rampProviderAccess: RampProviderAccess | null;
  selectedPairSupport: RampPair | null;
  selectedPair: SelectedRampPair;
  selectedCounterparty: Counterparty | null;
  amount: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const directionProviderOptions = useMemo(
    () =>
      surfacedRampProviderOptions(sdpEnvironment, enabledRampProviders).filter(
        (option) => Object.keys(getDirectionSupport(option.id, direction).currencies).length > 0
      ),
    [direction, enabledRampProviders, sdpEnvironment]
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
          amount,
          format: { t, locale },
        });
        return exclusion ? [exclusion] : [];
      }),
    [
      amount,
      direction,
      directionProviderOptions,
      locale,
      rampProviderAccess,
      selectedCounterparty,
      selectedPair,
      selectedPairSupport,
      t,
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
  return { providerExclusions, availableProviders };
}

/**
 * The currency pickers' options and changes: every fiat currency on offer, the assets the chosen
 * currency ramps to, and a change of either that lands on a supported pair.
 */
function usePairChoices({
  pairs,
  selectedPair,
  onPairChange,
}: {
  pairs: readonly RampPair[];
  selectedPair: SelectedRampPair;
  onPairChange: (pair: SelectedRampPair) => void;
}) {
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
  return { fiatCurrencies, assetRailsForFiat, selectFiatCurrency, selectAssetRail };
}

interface ProviderChoiceProps {
  availableProviders: readonly RampProviderOption[];
  selectedProvider: RampProviderId | null;
  estimatesByProvider: Map<RampProviderId, RampProviderEstimateResult>;
  estimatesLoading: boolean;
  onProviderSelect: (provider: RampProviderId) => void;
}

/**
 * The refresh surface's provider tiles, one radio group: the providers that can take the ramp
 * with their estimates, then the ones that cannot, each with its first reason.
 */
function ProviderQuoteTiles({
  direction,
  availableProviders,
  providerExclusions,
  selectedProvider,
  estimatesByProvider,
  estimatesLoading,
  onProviderSelect,
}: ProviderChoiceProps & {
  direction: RampDirection;
  providerExclusions: readonly ProviderExclusion[];
}) {
  const t = useTranslations();
  // The heading is a 13px field label; the tiles sit 12px under it in equal-height rows.
  return (
    <div className="space-y-3">
      <p className="text-meta font-medium text-primary">
        {t("DashboardPayments.ramps.chooseProvider")}
      </p>
      <div
        role="radiogroup"
        aria-label={t("DashboardPayments.ramps.chooseProvider")}
        className="grid auto-rows-fr gap-3 sm:grid-cols-2"
      >
        {availableProviders.map((option) => (
          <ProviderQuoteCard
            key={option.id}
            name={`${direction}-provider`}
            option={option}
            active={selectedProvider === option.id}
            estimate={estimatesByProvider.get(option.id)}
            estimateLoading={estimatesLoading}
            sandboxOnly={RAMP_PROVIDER_SURFACING[option.id] === "sandbox"}
            onSelect={() => onProviderSelect(option.id)}
          />
        ))}
        {providerExclusions.map((exclusion) => (
          <ProviderQuoteCard
            key={exclusion.option.id}
            name={`${direction}-provider`}
            option={exclusion.option}
            active={false}
            sandboxOnly={RAMP_PROVIDER_SURFACING[exclusion.option.id] === "sandbox"}
            unavailableReason={exclusion.reasons[0] ?? t("DashboardPayments.ramps.unavailable")}
            onSelect={() => {}}
          />
        ))}
      </div>
      {availableProviders.length === 0 && providerExclusions.length === 0 ? (
        <p className="text-body text-tertiary">
          {t("DashboardPayments.ramps.noProvidersAvailable")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The provider list outside refresh surfaces: the heading with a count of unavailable providers
 * that opens their reasons, then a scrolling list of the available providers' cards.
 */
function ProviderCardList({
  availableProviders,
  unavailableCount,
  selectedProvider,
  estimatesByProvider,
  estimatesLoading,
  onProviderSelect,
  onShowUnavailable,
}: ProviderChoiceProps & { unavailableCount: number; onShowUnavailable: () => void }) {
  const t = useTranslations();
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <p className="shrink-0 text-xl font-medium text-primary">
          {t("DashboardPayments.ramps.chooseProvider")}
        </p>
        {unavailableCount > 0 ? (
          <button
            type="button"
            onClick={onShowUnavailable}
            className="rounded-full bg-fill-subtle px-2 py-0.5 text-xs leading-none font-medium text-tertiary transition-colors hover:bg-fill-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tertiary focus-visible:ring-offset-2"
          >
            {t("DashboardPayments.ramps.unavailableCount", {
              count: unavailableCount,
            })}
          </button>
        ) : null}
        <div className="h-px flex-1 bg-fill-strong" />
      </div>

      <div className="-mx-1.5 h-96 overflow-y-auto px-1.5 py-1">
        <LazyMotion features={domMax}>
          <m.div layout className="space-y-2">
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
              <m.p
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-2 text-sm text-tertiary"
              >
                {t("DashboardPayments.ramps.noProvidersAvailable")}
              </m.p>
            ) : null}
          </m.div>
        </LazyMotion>
      </div>
    </div>
  );
}

/** A dialog listing every provider that cannot take this ramp, with all of its reasons. */
function UnavailableProvidersModal({
  open,
  providerExclusions,
  onClose,
}: {
  open: boolean;
  providerExclusions: readonly ProviderExclusion[];
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={open && providerExclusions.length > 0}
      onClose={onClose}
      ariaLabel={t("DashboardPayments.ramps.unavailableProviders")}
      size="md"
    >
      <div className="px-5 py-5">
        <h2 className="pr-10 text-lg font-medium text-primary">
          {t("DashboardPayments.ramps.unavailableProviders")}
        </h2>
        <div className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
          {providerExclusions.map((exclusion) => (
            <div
              key={exclusion.option.id}
              className="rounded-xl border border-border-default bg-fill-subtle p-3"
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
                  <p className="text-sm font-medium text-primary">{exclusion.option.title}</p>
                  <div className="mt-2 space-y-1 text-sm text-tertiary">
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
  );
}

export function RampPairProviderSelector({
  direction,
  enabledRampProviders,
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
  const { sdpEnvironment } = useDashboardWorkspace();
  const refresh = useThemeScope() === "refresh";
  const [unavailableDialogOpen, setUnavailableDialogOpen] = useState(false);
  const pairs = pairsForDirection(direction, sdpEnvironment, enabledRampProviders);
  const selectedPairSupport = useMemo(
    () => findRampPair(pairs, selectedPair),
    [pairs, selectedPair]
  );
  const { providerExclusions, availableProviders } = useProviderAvailability({
    direction,
    sdpEnvironment,
    enabledRampProviders,
    rampProviderAccess,
    selectedPairSupport,
    selectedPair,
    selectedCounterparty,
    amount,
  });
  const { estimatesByProvider, loading: estimatesLoading } = useRampEstimate({
    direction,
    selectedPair,
    amount,
    enabled: availableProviders.length > 0,
  });
  const { fiatCurrencies, assetRailsForFiat, selectFiatCurrency, selectAssetRail } = usePairChoices(
    { pairs, selectedPair, onPairChange }
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
    <div className="space-y-7 refresh:space-y-6">
      <RampSelectionProvider value={selectionContextValue}>
        <div className="flex flex-col gap-2">
          <CurrencyPairSelector />
        </div>
      </RampSelectionProvider>

      {refresh ? (
        <ProviderQuoteTiles
          direction={direction}
          availableProviders={availableProviders}
          providerExclusions={providerExclusions}
          selectedProvider={selectedProvider}
          estimatesByProvider={estimatesByProvider}
          estimatesLoading={estimatesLoading}
          onProviderSelect={onProviderSelect}
        />
      ) : (
        <ProviderCardList
          availableProviders={availableProviders}
          unavailableCount={providerExclusions.length}
          selectedProvider={selectedProvider}
          estimatesByProvider={estimatesByProvider}
          estimatesLoading={estimatesLoading}
          onProviderSelect={onProviderSelect}
          onShowUnavailable={() => setUnavailableDialogOpen(true)}
        />
      )}

      <UnavailableProvidersModal
        open={unavailableDialogOpen}
        providerExclusions={providerExclusions}
        onClose={() => setUnavailableDialogOpen(false)}
      />
    </div>
  );
}
