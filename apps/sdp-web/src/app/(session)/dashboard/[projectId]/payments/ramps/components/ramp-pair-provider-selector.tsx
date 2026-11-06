"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Counterparty } from "@sdp/types/counterparties";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { PaymentsDashboardWallet, RampProviderEstimateResult } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { RAMP_PROVIDER_SURFACING } from "@sdp/types/provider-access";
import { useCallback, useMemo } from "react";
import { useRampEstimate } from "@/app/(session)/dashboard/[projectId]/payments/ramps/hooks/use-ramp-estimate";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { RampProviderAccess } from "@/lib/provider-availability";
import {
  findRampPair,
  offrampPairs,
  onrampPairs,
  RAMP_PROVIDER_OPTIONS,
  type RampDirection,
  type RampPair,
  type RampProviderOption,
  rampPairKey,
  type SelectedRampPair,
  surfacedRampProviderOptions,
} from "@/lib/ramps";
import { CurrencyPairSelector } from "./currency-pair-selector";
import { ProviderQuoteCard } from "./provider-card";
import {
  buildProviderExclusion,
  getDirectionSupport,
  type ProviderExclusion,
} from "./provider-exclusions";
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
 * Every provider in the catalog's own order, each marked with its exclusion when it can't take
 * the ramp: a tile stays where it is as the amount changes instead of jumping to the end.
 */
function tilesInStaticOrder(
  availableProviders: readonly RampProviderOption[],
  providerExclusions: readonly ProviderExclusion[]
): { option: RampProviderOption; exclusion: ProviderExclusion | null }[] {
  const rank = (option: RampProviderOption) =>
    RAMP_PROVIDER_OPTIONS.findIndex((candidate) => candidate.id === option.id);
  return [
    ...availableProviders.map((option) => ({ option, exclusion: null })),
    ...providerExclusions.map((exclusion) => ({ option: exclusion.option, exclusion })),
  ].sort((left, right) => rank(left.option) - rank(right.option));
}

/**
 * The provider tiles, one radio group: every provider in a fixed order, the ones that can take
 * the ramp with their estimates, the others with their first reason.
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
        {tilesInStaticOrder(availableProviders, providerExclusions).map((tile) =>
          tile.exclusion ? (
            <ProviderQuoteCard
              key={tile.option.id}
              name={`${direction}-provider`}
              option={tile.option}
              active={false}
              sandboxOnly={RAMP_PROVIDER_SURFACING[tile.option.id] === "sandbox"}
              unavailableReason={
                tile.exclusion.reasons[0] ?? t("DashboardPayments.ramps.unavailable")
              }
              onSelect={() => {}}
            />
          ) : (
            <ProviderQuoteCard
              key={tile.option.id}
              name={`${direction}-provider`}
              option={tile.option}
              active={selectedProvider === tile.option.id}
              estimate={estimatesByProvider.get(tile.option.id)}
              estimateLoading={estimatesLoading}
              sandboxOnly={RAMP_PROVIDER_SURFACING[tile.option.id] === "sandbox"}
              onSelect={() => onProviderSelect(tile.option.id)}
            />
          )
        )}
      </div>
      {availableProviders.length === 0 && providerExclusions.length === 0 ? (
        <p className="text-body text-tertiary">
          {t("DashboardPayments.ramps.noProvidersAvailable")}
        </p>
      ) : null}
    </div>
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
    <div className="space-y-6">
      <RampSelectionProvider value={selectionContextValue}>
        <div className="flex flex-col gap-2">
          <CurrencyPairSelector />
        </div>
      </RampSelectionProvider>

      <ProviderQuoteTiles
        direction={direction}
        availableProviders={availableProviders}
        providerExclusions={providerExclusions}
        selectedProvider={selectedProvider}
        estimatesByProvider={estimatesByProvider}
        estimatesLoading={estimatesLoading}
        onProviderSelect={onProviderSelect}
      />
    </div>
  );
}
