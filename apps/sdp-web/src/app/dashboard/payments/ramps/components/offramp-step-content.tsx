"use client";

import { PlusIcon, WalletIcon } from "lucide-react";
import { useMemo } from "react";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Combobox } from "@/components/ui/combobox";
import { OFFRAMP_PAIRS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { CounterpartySelector } from "./counterparty-selector";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampStepPlaceholder } from "./ramp-step-placeholder";

export function OfframpStepContent({ wizard }: { wizard: OfframpWizard }) {
  const {
    currentStepId,
    enabledRampProviders,
    liveCounterpartiesResult,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    fields,
    quote,
    setField,
    setCounterpartyDialogOpen,
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

  if (currentStepId === "COUNTERPARTY") {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setCounterpartyDialogOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-light px-4 py-3.5 text-left transition-colors hover:border-border-medium hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
            <PlusIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-text-extra-high">Add counterparty</span>
            <span className="block text-sm text-text-low">
              Create a new payee to pay out to if they aren&apos;t in the list yet.
            </span>
          </span>
        </button>
        <CounterpartySelector
          counterpartiesResult={liveCounterpartiesResult}
          value={fields.counterpartyId || null}
          onChange={(id) => setField("counterpartyId", id)}
        />
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
      </div>
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
