"use client";

import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Combobox } from "@/components/ui/combobox";
import { OFFRAMP_PAIRS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampStepPlaceholder } from "./ramp-step-placeholder";

export function OfframpStepContent({ wizard }: { wizard: OfframpWizard }) {
  const {
    currentStepId,
    enabledRampProviders,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    fields,
    quote,
    setField,
    handlePairChange,
  } = wizard;

  const walletOptions = useMemo(
    () =>
      liveWallets.map((wallet) => {
        const total = wallet.balances ? resolveTotalBalance(wallet.balances) : null;
        return {
          value: wallet.walletId,
          label: wallet.label ?? wallet.walletId,
          description: total !== null ? formatCurrencyAmount(total) : undefined,
        };
      }),
    [liveWallets]
  );

  if (currentStepId === "WALLET") {
    return (
      <Combobox
        label="Source wallet"
        value={fields.walletId || null}
        onChange={(walletId) => setField("walletId", walletId)}
        options={walletOptions}
        placeholder="Select a source wallet"
        searchPlaceholder="Search wallets"
        icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
        isLoading={walletsLoading}
      />
    );
  }

  if (currentStepId === "WITHDRAW") {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No off-ramp providers are enabled for this organization.
        </div>
      );
    }

    return (
      <RampPairProviderSelector
        direction="offramp"
        pairs={OFFRAMP_PAIRS}
        enabledRampProviders={enabledRampProviders}
        providerOptions={RAMP_PROVIDER_OPTIONS}
        wallets={liveWallets}
        walletsLoading={walletsLoading}
        selectedWallet={selectedWallet}
        showWallet={false}
        selectedPair={selectedRampPair}
        selectedProvider={fields.provider}
        amount={fields.amount}
        onAmountChange={(value) => setField("amount", value)}
        onAmountBlur={() => {}}
        onWalletChange={(walletId) => setField("walletId", walletId)}
        onPairChange={handlePairChange}
        onProviderSelect={(nextProvider) => setField("provider", nextProvider)}
      />
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "hosted") {
    return (
      <div className="overflow-hidden rounded-2xl">
        <iframe
          title={`${quote.provider} off-ramp`}
          src={quote.hostedUrl}
          className="h-[480px] w-full border-0"
          allow="accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment"
        />
      </div>
    );
  }

  return <RampStepPlaceholder />;
}
