"use client";

import { ONRAMP_PAIRS, RAMP_PROVIDER_OPTIONS, toRampCryptoToken } from "@/lib/ramps";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampStepPlaceholder } from "./ramp-step-placeholder";

export function OnrampStepContent({ wizard }: { wizard: OnrampWizard }) {
  const {
    currentStepId,
    enabledRampProviders,
    fields,
    setField,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    bvnkInstruction,
    quote,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
    handlePairChange,
  } = wizard;

  if (currentStepId === "DEPOSIT") {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No on-ramp providers are enabled for this organization.
        </div>
      );
    }

    return (
      <RampPairProviderSelector
        direction="onramp"
        pairs={ONRAMP_PAIRS}
        enabledRampProviders={enabledRampProviders}
        providerOptions={RAMP_PROVIDER_OPTIONS}
        wallets={liveWallets}
        walletsLoading={walletsLoading}
        selectedWallet={selectedWallet}
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

  if (currentStepId === "PROVIDER" && bvnkInstruction?.onboardingStatus === "verifying") {
    return (
      <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
        We're reviewing your details. This usually takes a few minutes — you can come back to
        complete your deposit once verification is approved.
      </div>
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "hosted") {
    return (
      <div className="overflow-hidden rounded-2xl">
        <iframe
          title={`${quote.provider} on-ramp`}
          src={quote.hostedUrl}
          className="h-[480px] w-full border-0"
          allow="accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment"
        />
      </div>
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "manual_instructions") {
    return (
      <ManualInstructionsQuote
        amount={fields.amount.trim()}
        quote={quote}
        fiatCurrency={selectedRampPair.fiatCurrency}
        cryptoToken={toRampCryptoToken(selectedRampPair.assetRail)}
        instructions={quote.paymentInstructions ?? []}
        simulateQuote={
          quote.provider === "lightspark" || quote.provider === "bvnk"
            ? {
                loading: quoteSimulationLoading,
                succeeded: quoteSimulationSucceeded,
                onClick: () => void simulateCurrentQuote(),
              }
            : undefined
        }
      />
    );
  }

  return <RampStepPlaceholder />;
}
