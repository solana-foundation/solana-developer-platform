"use client";

import { DollarSignIcon } from "lucide-react";
import { ONRAMP_PAIRS, RAMP_PROVIDER_OPTIONS, toRampCryptoToken } from "@/lib/ramps";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { HostedRampFrame } from "./hosted-ramp-frame";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { hasOnboardingLifecycle, simulateActionLabels } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";

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
    onboarding,
    retryOnboarding,
    quote,
    transferStatus,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
    handlePairChange,
    requirementFields,
    collectedData,
    setCollectedField,
    requirementsBlocker,
  } = wizard;

  if (currentStepId === "DEPOSIT") {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No deposit providers are enabled for this organization.
        </div>
      );
    }

    return (
      <div className="space-y-4">
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
        {requirementsBlocker ? (
          <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
            {requirementsBlocker}
          </div>
        ) : null}
      </div>
    );
  }

  if (currentStepId === "REQUIREMENTS") {
    return (
      <RequirementsFields
        fields={requirementFields}
        values={collectedData}
        onChange={setCollectedField}
      />
    );
  }

  if (
    currentStepId === "PROVIDER" &&
    onboarding &&
    !quote &&
    hasOnboardingLifecycle(onboarding.provider)
  ) {
    return (
      <RampOnboardingPanel direction="onramp" onboarding={onboarding} onRetry={retryOnboarding} />
    );
  }

  if (currentStepId === "PROVIDER" && quote && transferStatus?.status === "completed") {
    return <RampCompleteScreen direction="onramp" quote={quote} transfer={transferStatus} />;
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        <HostedRampFrame title={`${quote.provider} deposit`} src={quote.hostedUrl} />
        <div className="border-t border-border-light pt-5">
          <RampStatusPanel direction="onramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "manual_instructions") {
    if (!quote.paymentInstructions) {
      return (
        <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-5 py-5 text-sm text-status-error-text">
          Ramp quote is missing payment instructions.
        </div>
      );
    }

    const labels = simulateActionLabels(quote.provider);
    const simulateAction = labels
      ? {
          loading: quoteSimulationLoading,
          succeeded: quoteSimulationSucceeded,
          onClick: () => void simulateCurrentQuote(),
          icon: <DollarSignIcon />,
          idleLabel: labels.idle,
          busyLabel: labels.busy,
          doneLabel: labels.done,
        }
      : undefined;
    return (
      <div className="space-y-6">
        <ManualInstructionsQuote
          amount={fields.amount.trim()}
          quote={quote}
          fiatCurrency={selectedRampPair.fiatCurrency}
          cryptoToken={toRampCryptoToken(selectedRampPair.assetRail)}
          instructions={quote.paymentInstructions}
          action={simulateAction}
        />
        <div className="border-t border-border-light pt-5">
          <RampStatusPanel direction="onramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  return <RampQuoteSkeleton />;
}
