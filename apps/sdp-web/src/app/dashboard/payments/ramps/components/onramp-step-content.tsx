"use client";

import { isMuralSandboxPayinCurrency, isTerminalRampTransferStatus } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { DollarSignIcon } from "lucide-react";
import { useThemeScope } from "@/components/theme-scope";
import { Callout } from "@/components/ui/callout";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { BvnkAgreementConsent } from "./bvnk-agreement-consent";
import { CoinbaseQuoteSummary } from "./coinbase/quote-summary";
import { CoinbaseRampFrame } from "./coinbase/ramp-frame";
import { ContactCombobox, type ContactControls } from "./contact-combobox";
import { DepositTimeline } from "./deposit-timeline";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { MemoStepContent } from "./memo-step-content";
import { MoneygramRampWidget } from "./moneygram-ramp-widget";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { OnrampReview } from "./onramp-review";
import { hasOnboardingLifecycle, isOnboardingPanelStatus, simulateActionLabels } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";
import { StripeOnrampFrame } from "./stripe-onramp-frame";

interface StepContentProps {
  wizard: OnrampWizard;
  /** Deposit picks its contact on the details step; omitted when it was picked before. */
  contact?: ContactControls;
}

type OnrampQuote = NonNullable<OnrampWizard["quote"]>;
type ManualInstructionsQuoteRecord = Extract<OnrampQuote, { deliveryMode: "manual_instructions" }>;

/** The details step: the contact, then the amount, wallet, currency pair and provider. */
function DepositStep({ wizard, contact }: StepContentProps) {
  const t = useTranslations();
  const {
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
    handlePairChange,
    requirementsBlocker,
  } = wizard;

  if (!hasEnabledRampProvider(rampProviderAccess)) {
    return (
      <div className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-5 text-sm text-tertiary">
        {t("DashboardPayments.ramps.noDepositProviders")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {contact ? (
        <ContactCombobox
          {...contact}
          value={fields.counterpartyId}
          hint={t("DashboardPayments.depositMethod.contactHint")}
        />
      ) : null}
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

/** What the provider needs: agreements to accept, an onboarding in progress, or its fields. */
function RequirementsStep({ wizard }: { wizard: OnrampWizard }) {
  const {
    fields,
    onboarding,
    isAdvancing,
    retryOnboarding,
    pendingAgreements,
    acceptedAgreements,
    toggleAgreement,
    requirementFields,
    collectedData,
    setCollectedField,
  } = wizard;
  if (pendingAgreements !== null) {
    return (
      <BvnkAgreementConsent
        agreements={pendingAgreements}
        acceptedAgreements={acceptedAgreements}
        onToggle={toggleAgreement}
        disabled={isAdvancing}
      />
    );
  }
  if (
    onboarding !== null &&
    hasOnboardingLifecycle(onboarding.provider) &&
    isOnboardingPanelStatus(onboarding)
  ) {
    return (
      <RampOnboardingPanel direction="onramp" onboarding={onboarding} onRetry={retryOnboarding} />
    );
  }
  // Native fieldset[disabled] freezes every nested input and combobox trigger
  // while the advance POST is in flight, so mid-flight edits can't desync the
  // form from what the provider was sent.
  return (
    <fieldset disabled={isAdvancing} className="min-w-0">
      <RequirementsFields
        provider={fields.provider}
        fields={requirementFields}
        values={collectedData}
        onChange={setCollectedField}
      />
    </fieldset>
  );
}

/** A quote paid by bank transfer: the instructions, with the funding wait around them. */
function ManualInstructionsStep({
  wizard,
  quote,
}: {
  wizard: OnrampWizard;
  quote: ManualInstructionsQuoteRecord;
}) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const {
    fields,
    selectedRampPair,
    transferStatus,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
  } = wizard;
  // Terminal check precedes the missing-instructions guard: a dead transfer is not a quote defect.
  if (transferStatus !== undefined && isTerminalRampTransferStatus(transferStatus.status)) {
    return <RampStatusPanel direction="onramp" transfer={transferStatus} />;
  }

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
  const instructionsQuote = (
    <ManualInstructionsQuote
      amount={fields.amount.trim()}
      quote={quote}
      fiatCurrency={selectedRampPair.fiatCurrency}
      cryptoToken={getCryptoRailAssetLabel(selectedRampPair.assetRail)}
      instructions={quote.paymentInstructions}
      action={simulateAction}
    />
  );
  return refresh ? (
    <div className="space-y-8">
      <Callout variant="warning" title={t("DashboardPayments.ramps.status.waitingForFunding")}>
        {t("DashboardPayments.manualInstructions.waitingBody")}
      </Callout>
      {instructionsQuote}
      <DepositTimeline status={transferStatus?.status} />
    </div>
  ) : (
    instructionsQuote
  );
}

/**
 * The provider step: the quote's own surface (a hosted frame, a widget, bank instructions),
 * the onboarding or error that stands in its way, or the outcome once the transfer is done.
 */
function ProviderStep({ wizard }: { wizard: OnrampWizard }) {
  const t = useTranslations();
  const {
    fields,
    selectedWallet,
    selectedRampPair,
    onboarding,
    retryOnboarding,
    quote,
    transferStatus,
    refreshQuote,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
  } = wizard;

  if (!quote && quoteCreationError) {
    return (
      <RampQuoteError
        error={quoteCreationError}
        retrying={quoteCreationRetrying}
        onRetry={() => void retryQuoteCreation()}
      />
    );
  }

  if (
    onboarding &&
    !quote &&
    hasOnboardingLifecycle(onboarding.provider) &&
    isOnboardingPanelStatus(onboarding)
  ) {
    return (
      <RampOnboardingPanel direction="onramp" onboarding={onboarding} onRetry={retryOnboarding} />
    );
  }

  if (quote && wizard.showCompleteScreen) {
    if (transferStatus === undefined) {
      return <RampQuoteSkeleton />;
    }
    return <RampCompleteScreen direction="onramp" quote={quote} transfer={transferStatus} />;
  }

  if (quote?.provider === "stripe") {
    return (
      <StripeOnrampFrame clientSecret={quote.clientSecret} publishableKey={quote.publishableKey} />
    );
  }

  if (quote?.provider === "moneygram") {
    if (!selectedWallet || wizard.quoteTransferId === null) {
      return <RampQuoteSkeleton />;
    }
    return (
      <MoneygramRampWidget
        direction="onramp"
        quote={quote}
        transferId={wizard.quoteTransferId}
        sourceWalletId={selectedWallet.id}
        sourceWalletName={selectedWallet.label ?? selectedWallet.walletId}
        sourceWalletAddress={selectedWallet.publicKey}
        sourceTokenMint={null}
        cryptoAsset={getCryptoRailAssetLabel(selectedRampPair.assetRail)}
        cryptoAmount={fields.amount.trim()}
        fiatCurrency={selectedRampPair.fiatCurrency}
        onSessionExpiring={refreshQuote}
      />
    );
  }

  if (quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        {quote.provider === "coinbase" ? (
          <>
            <CoinbaseQuoteSummary quote={quote} />
            <CoinbaseRampFrame orderId={quote.id} src={quote.hostedUrl} />
          </>
        ) : (
          <MoonpayRampFrame
            title={t("DashboardPayments.ramps.providerDeposit", { provider: quote.provider })}
            src={quote.hostedUrl}
          />
        )}
      </div>
    );
  }

  if (quote?.deliveryMode === "manual_instructions") {
    return <ManualInstructionsStep wizard={wizard} quote={quote} />;
  }

  return <RampQuoteSkeleton />;
}

/**
 * Renders content for the active onramp wizard step.
 *
 * @param props - The active onramp wizard state.
 * @returns The active onramp step content.
 */
export function OnrampStepContent({ wizard, contact }: StepContentProps) {
  switch (wizard.currentStepId) {
    case "MEMO":
      return <MemoStepContent rows={wizard.memoRows} onChange={wizard.setMemoRows} />;
    case "REVIEW":
      return <OnrampReview wizard={wizard} />;
    case "DEPOSIT":
      return <DepositStep wizard={wizard} contact={contact} />;
    case "REQUIREMENTS":
      return <RequirementsStep wizard={wizard} />;
    case "PROVIDER":
      return <ProviderStep wizard={wizard} />;
    default:
      return <RampQuoteSkeleton />;
  }
}
