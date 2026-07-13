"use client";

import { isMuralSandboxPayinCurrency } from "@sdp/types";
import { DollarSignIcon } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import { toRampCryptoToken } from "@/lib/ramps";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { CoinbaseRampFrame } from "./coinbase/ramp-frame";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { hasOnboardingLifecycle, simulateActionLabels } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";
import { StripeOnrampFrame } from "./stripe-onramp-frame";

export function OnrampStepContent({ wizard }: { wizard: OnrampWizard }) {
  const t = useTranslations();
  const {
    currentStepId,
    rampProviderAccess,
    selectedCounterparty,
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
    if (!hasEnabledRampProvider(rampProviderAccess)) {
      return (
        <div className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-5 text-sm text-tertiary">
          {t("DashboardPayments.ramps.noDepositProviders")}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <RampPairProviderSelector
          direction="onramp"
          rampProviderAccess={rampProviderAccess}
          selectedCounterparty={selectedCounterparty}
          wallets={liveWallets}
          walletsLoading={walletsLoading}
          selectedWallet={selectedWallet}
          showWallet={true}
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
          <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
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

  if (currentStepId === "PROVIDER" && quote?.provider === "stripe") {
    return (
      <div className="space-y-6">
        <StripeOnrampFrame
          clientSecret={quote.clientSecret}
          publishableKey={quote.publishableKey}
        />
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="onramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        {quote.provider === "coinbase" ? (
          <CoinbaseRampFrame orderId={quote.id} src={quote.hostedUrl} />
        ) : (
          <MoonpayRampFrame
            title={t("DashboardPayments.ramps.providerDeposit", { provider: quote.provider })}
            src={quote.hostedUrl}
          />
        )}
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="onramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "manual_instructions") {
    if (!quote.paymentInstructions) {
      return (
        <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
          {t("DashboardPayments.ramps.quoteMissingInstructions")}
        </div>
      );
    }

    const labels =
      quote.provider === "mural" && !isMuralSandboxPayinCurrency(selectedRampPair.fiatCurrency)
        ? null
        : simulateActionLabels(quote.provider, t);
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
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="onramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  return <RampQuoteSkeleton />;
}
