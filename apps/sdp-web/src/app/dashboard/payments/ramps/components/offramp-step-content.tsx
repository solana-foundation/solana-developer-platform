"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { MemoStepContent } from "./memo-step-content";
import { MoneygramRampWidget } from "./moneygram-ramp-widget";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { hasOnboardingLifecycle, isOnboardingPanelStatus } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";
import { WalletAssetBreakdown } from "./wallet-asset-breakdown";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function OfframpManualQuoteStep({
  wizard,
  quote,
  t,
}: {
  wizard: OfframpWizard;
  quote: Extract<NonNullable<OfframpWizard["quote"]>, { deliveryMode: "manual_instructions" }>;
  t: Translate;
}) {
  const { selectedRampPair, fields } = wizard;

  if (!quote.paymentInstructions) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.quoteMissingInstructions")}
      </div>
    );
  }

  const cryptoToken = getCryptoRailAssetLabel(selectedRampPair.assetRail);

  return (
    <ManualInstructionsQuote
      amount={fields.amount.trim()}
      quote={quote}
      fiatCurrency={selectedRampPair.fiatCurrency}
      cryptoToken={cryptoToken}
      instructions={quote.paymentInstructions}
      description={t("DashboardPayments.ramps.offrampManualDescription", {
        amount: fields.amount.trim(),
        token: cryptoToken,
      })}
    />
  );
}

export function OfframpStepContent({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const {
    currentStepId,
    enabledRampProviders,
    rampProviderAccess,
    selectedCounterparty,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    fields,
    quote,
    transferStatus,
    setField,
    handlePairChange,
    requirementFields,
    existingPayoutAccounts,
    payoutAccountSelection,
    selectedProviderAccountId,
    addingNewAccount,
    selectPayoutAccount,
    collectedData,
    setCollectedField,
    requirementsBlocker,
    sourceTokenMint,
    refreshQuote,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
    onboarding,
    isAdvancing,
    retryOnboarding,
    memoRows,
    setMemoRows,
  } = wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);
  const destinationCountry =
    collectedData.destinationCountry === undefined ? "" : collectedData.destinationCountry;
  const paymentRails = collectedData.paymentRails === undefined ? "" : collectedData.paymentRails;
  const payoutAccountChoice = addingNewAccount ? "new" : selectedProviderAccountId;
  const requirementsKey = [
    "offramp-requirements",
    destinationCountry,
    paymentRails,
    payoutAccountChoice,
  ].join(":");

  if (currentStepId === "WALLET") {
    return (
      <div className="space-y-4">
        <Combobox
          label={t("DashboardPayments.ramps.sourceWallet")}
          value={fields.walletId || null}
          onChange={(walletId) => setField("walletId", walletId)}
          options={walletOptions}
          placeholder={t("DashboardPayments.ramps.selectSourceWallet")}
          searchPlaceholder={t("DashboardPayments.ramps.searchWallets")}
          icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
          isLoading={walletsLoading}
        />
        {selectedWallet ? <WalletAssetBreakdown wallet={selectedWallet} /> : null}
      </div>
    );
  }

  if (currentStepId === "WITHDRAW") {
    if (!hasEnabledRampProvider(rampProviderAccess)) {
      return (
        <div className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-5 text-sm text-tertiary">
          {t("DashboardPayments.ramps.noPayoutProviders")}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <RampPairProviderSelector
          direction="offramp"
          enabledRampProviders={enabledRampProviders}
          rampProviderAccess={rampProviderAccess}
          selectedCounterparty={selectedCounterparty}
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
        {requirementsBlocker ? (
          <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
            {requirementsBlocker}
          </div>
        ) : null}
      </div>
    );
  }

  if (currentStepId === "MEMO") {
    return <MemoStepContent rows={memoRows} onChange={setMemoRows} />;
  }

  if (currentStepId === "REQUIREMENTS") {
    // Native fieldset[disabled] freezes every nested input, combobox trigger and
    // account-chooser button while the advance POST is in flight, so mid-flight
    // edits can't desync the form from what the provider was sent.
    return (
      <fieldset disabled={isAdvancing} className="min-w-0">
        <RequirementsFields
          key={requirementsKey}
          provider={fields.provider}
          fields={requirementFields}
          values={collectedData}
          onChange={setCollectedField}
          existingPayoutAccounts={existingPayoutAccounts}
          payoutAccountSelection={payoutAccountSelection}
          onPayoutAccountSelectionChange={selectPayoutAccount}
        />
      </fieldset>
    );
  }

  if (currentStepId === "COMPLETE" && !quote && quoteCreationError) {
    return (
      <RampQuoteError
        error={quoteCreationError}
        retrying={quoteCreationRetrying}
        onRetry={() => void retryQuoteCreation()}
      />
    );
  }

  if (
    currentStepId === "COMPLETE" &&
    onboarding &&
    !quote &&
    hasOnboardingLifecycle(onboarding.provider) &&
    isOnboardingPanelStatus(onboarding.status)
  ) {
    return (
      <RampOnboardingPanel direction="offramp" onboarding={onboarding} onRetry={retryOnboarding} />
    );
  }

  if (currentStepId === "COMPLETE" && quote && transferStatus?.status === "completed") {
    return <RampCompleteScreen direction="offramp" quote={quote} transfer={transferStatus} />;
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "hosted") {
    return (
      <MoonpayRampFrame
        title={t("DashboardPayments.ramps.providerPayout", { provider: quote.provider })}
        src={quote.hostedUrl}
      />
    );
  }

  if (currentStepId === "COMPLETE" && quote?.provider === "moneygram") {
    if (!selectedWallet) {
      return <RampQuoteSkeleton />;
    }
    return (
      <div className="space-y-6">
        <MoneygramRampWidget
          direction="offramp"
          quote={quote}
          sourceWalletId={selectedWallet.id}
          sourceWalletName={selectedWallet.label ?? selectedWallet.walletId}
          sourceWalletAddress={selectedWallet.publicKey}
          sourceTokenMint={sourceTokenMint}
          cryptoAsset={getCryptoRailAssetLabel(selectedRampPair.assetRail)}
          cryptoAmount={fields.amount.trim()}
          fiatCurrency={selectedRampPair.fiatCurrency}
          onSessionExpiring={refreshQuote}
        />
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="offramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "manual_instructions") {
    return <OfframpManualQuoteStep wizard={wizard} quote={quote} t={t} />;
  }

  return <RampQuoteSkeleton />;
}
