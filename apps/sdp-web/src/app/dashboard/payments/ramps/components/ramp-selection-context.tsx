"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import { createContext, type ReactNode, useContext } from "react";
import type { RampDirection, SelectedRampPair } from "@/lib/ramps";

interface RampSelectionContextValue {
  direction: RampDirection;
  fiatCurrencies: readonly RampFiatCurrency[];
  assetRails: readonly CryptoRailId[];
  wallets: readonly PaymentsDashboardWallet[];
  walletsLoading: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  selectedPair: SelectedRampPair;
  amount: string;
  onAmountChange: (amount: string) => void;
  onAmountBlur: () => void;
  onWalletChange: (walletId: string) => void;
  onFiatCurrencyChange: (fiatCurrency: RampFiatCurrency) => void;
  onAssetRailChange: (assetRail: CryptoRailId) => void;
}

const RampSelectionContext = createContext<RampSelectionContextValue | null>(null);

export function RampSelectionProvider({
  value,
  children,
}: {
  value: RampSelectionContextValue;
  children: ReactNode;
}) {
  return <RampSelectionContext value={value}>{children}</RampSelectionContext>;
}

export function useRampSelection() {
  const context = useContext(RampSelectionContext);
  if (!context) {
    throw new Error("useRampSelection must be used within RampSelectionProvider");
  }

  return context;
}
