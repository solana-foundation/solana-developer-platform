"use client";

import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { MemoStepContent } from "./memo-step-content";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RequirementsFields } from "./requirements-fields";
import { StripeOnrampFrame } from "./stripe-onramp-frame";

/**
 * Renders content for the active onramp wizard step.
 *
 * @param props - The active onramp wizard state.
 * @returns The active onramp step content.
 */
export function OnrampStepContent({ wizard }: { wizard: OnrampWizard }) {
  const t = useTranslations();
  const {
    currentStepId,
    enabledRampProviders,
    rampProviderAccess,
    selectedCounterparty,
    fields,
    setField,
    selectProvider,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    isAdvancing,
    quote,
    transferStatus,
    handlePairChange,
    requirementFields,
    collectedData,
    setCollectedField,
    requirementsBlocker,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
    memoRows,
    setMemoRows,
  } = wizard;

  if (currentStepId === "MEMO") {
    return <MemoStepContent rows={memoRows} onChange={setMemoRows} />;
  }

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
          enabledRampProviders={enabledRampProviders}
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
          onProviderSelect={selectProvider}
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
      <fieldset disabled={isAdvancing} className="min-w-0">
        <RequirementsFields
          fields={requirementFields}
          values={collectedData}
          onChange={setCollectedField}
        />
      </fieldset>
    );
  }

  if (currentStepId === "PROVIDER" && !quote && quoteCreationError) {
    return (
      <RampQuoteError
        error={quoteCreationError}
        retrying={quoteCreationRetrying}
        onRetry={() => void retryQuoteCreation()}
      />
    );
  }

  if (currentStepId === "PROVIDER" && quote && wizard.showCompleteScreen) {
    if (transferStatus === undefined) {
      return <RampQuoteSkeleton />;
    }
    return <RampCompleteScreen direction="onramp" quote={quote} transfer={transferStatus} />;
  }

  if (currentStepId === "PROVIDER" && quote?.provider === "stripe") {
    return (
      <StripeOnrampFrame clientSecret={quote.clientSecret} publishableKey={quote.publishableKey} />
    );
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "hosted") {
    return (
      <MoonpayRampFrame
        title={t("DashboardPayments.ramps.providerDeposit", { provider: quote.provider })}
        src={quote.hostedUrl}
      />
    );
  }

  return <RampQuoteSkeleton />;
}
