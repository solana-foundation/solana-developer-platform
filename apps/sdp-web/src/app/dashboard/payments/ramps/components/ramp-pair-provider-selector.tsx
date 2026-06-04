"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo } from "react";
import {
  findRampPair,
  type RampDirection,
  type RampPair,
  type RampProviderOption,
  rampPairKey,
  type SelectedRampPair,
} from "@/lib/ramps";
import { CurrencyPairSelector } from "./currency-pair-selector";
import { ProviderCard } from "./provider-card";
import { RampSelectionProvider } from "./ramp-selection-context";

interface RampPairProviderSelectorProps {
  direction: RampDirection;
  pairs: readonly RampPair[];
  enabledRampProviders: readonly RampProviderId[];
  providerOptions: readonly RampProviderOption[];
  wallets: readonly PaymentsDashboardWallet[];
  walletsLoading: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  showWallet?: boolean;
  selectedPair: SelectedRampPair;
  selectedProvider: RampProviderId | null;
  amount: string;
  onAmountChange: (amount: string) => void;
  onAmountBlur: () => void;
  onWalletChange: (walletId: string) => void;
  onPairChange: (pair: SelectedRampPair) => void;
  onProviderSelect: (provider: RampProviderId) => void;
}

export function RampPairProviderSelector({
  direction,
  pairs,
  enabledRampProviders,
  providerOptions,
  wallets,
  walletsLoading,
  selectedWallet,
  showWallet = true,
  selectedPair,
  selectedProvider,
  amount,
  onAmountChange,
  onAmountBlur,
  onWalletChange,
  onPairChange,
  onProviderSelect,
}: RampPairProviderSelectorProps) {
  const selectedPairSupport = useMemo(
    () => findRampPair(pairs, selectedPair),
    [pairs, selectedPair]
  );
  const enabledProviderSet = useMemo(() => new Set(enabledRampProviders), [enabledRampProviders]);
  const supportedProviderSet = useMemo(
    () => new Set(selectedPairSupport?.providers ?? []),
    [selectedPairSupport]
  );
  const availableProviders = useMemo(
    () =>
      providerOptions.filter(
        (option) => enabledProviderSet.has(option.id) && supportedProviderSet.has(option.id)
      ),
    [providerOptions, enabledProviderSet, supportedProviderSet]
  );
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
          <p className="shrink-0 text-xl font-medium text-text-extra-high">Choose a provider</p>
          <div className="h-px flex-1 bg-border-light" />
        </div>

        {/* Fixed height keeps the sticky footer from shifting as providers animate in/out. */}
        <div className="-mx-1.5 h-48 overflow-y-auto px-1.5 py-1">
          <motion.div layout className="space-y-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {availableProviders.map((option) => (
                <ProviderCard
                  key={option.id}
                  option={option}
                  active={selectedProvider === option.id}
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
                No providers support this currency pair yet.
              </motion.p>
            ) : null}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
