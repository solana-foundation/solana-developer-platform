"use client";

import { isTerminalRampTransferStatus } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OfframpWizard } from "../hooks/use-offramp-wizard.redesign";
import { walletComboboxOptions } from "../wallet-options";
import { BvnkAgreementConsent } from "./bvnk-agreement-consent.redesign";
import { ManualInstructionsQuote } from "./manual-instructions-quote.redesign";
import { MemoStepContent } from "./memo-step-content.redesign";
import { MoneygramRampWidget } from "./moneygram-ramp-widget";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { hasOnboardingLifecycle, isOnboardingPanelStatus } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector.redesign";
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
  const { selectedRampPair, fields, transferStatus } = wizard;

  // Terminal check precedes the missing-instructions guard: a dead transfer is not a quote defect.
  if (transferStatus !== undefined && isTerminalRampTransferStatus(transferStatus.status)) {
    return <RampStatusPanel direction="offramp" transfer={transferStatus} />;
  }

  if (!quote.paymentInstructions) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.quoteMissingInstructions")}
      </div>
    );
  }

  const cryptoToken = getCryptoRailAssetLabel(selectedRampPair.assetRail);
  const depositCopy = { amount: fields.amount.trim(), token: cryptoToken };

  return (
    <ManualInstructionsQuote
      amount={fields.amount.trim()}
      quote={quote}
      fiatCurrency={selectedRampPair.fiatCurrency}
      cryptoToken={cryptoToken}
      instructions={quote.paymentInstructions}
      // Held for approval: the send is already queued, so asking for it again
      // would invite a second payment, and the quote is not held while it waits.
      description={
        wizard.heldApprovalRequestId === null
          ? t("DashboardPayments.ramps.offrampManualDescription", depositCopy)
          : t("DashboardPayments.ramps.offrampHeldDescription", depositCopy)
      }
    />
  );
}

function OfframpWalletStep({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const { liveWallets, walletsLoading, selectedWallet, fields, setField, sourceWalletHint } =
    wizard;
  const walletOptions = useMemo(
    () =>
      walletComboboxOptions(liveWallets, t("DashboardPayments.restricted"), {
        disableRestricted: true,
      }),
    [liveWallets, t]
  );

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
      <p hidden={!sourceWalletHint} className="text-sm text-warning">
        {sourceWalletHint}
      </p>
      {selectedWallet ? <WalletAssetBreakdown wallet={selectedWallet} /> : null}
    </div>
  );
}

function RequirementsBlocker({ message }: { message: string | null }) {
  return message ? (
    <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
      {message}
    </div>
  ) : null;
}

function OfframpWithdrawStep({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const {
    enabledRampProviders,
    rampProviderAccess,
    selectedCounterparty,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    fields,
    setField,
    selectProvider,
    handlePairChange,
    requirementsBlocker,
  } = wizard;

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
        onProviderSelect={selectProvider}
      />
      <RequirementsBlocker message={requirementsBlocker} />
    </div>
  );
}

function OfframpRequirementsStep({ wizard }: { wizard: OfframpWizard }) {
  const {
    fields,
    requirementFields,
    selectedProviderAccountId,
    payoutAccounts,
    selectPayoutAccount,
    collectedData,
    setCollectedField,
    requirementsBlocker,
    onboarding,
    isAdvancing,
    retryOnboarding,
    pendingAgreements,
    acceptedAgreements,
    toggleAgreement,
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
      <RampOnboardingPanel direction="offramp" onboarding={onboarding} onRetry={retryOnboarding} />
    );
  }

  const requirementsKey = [
    "offramp-requirements",
    collectedData.destinationCountry ?? "",
    collectedData.paymentRails ?? "",
    selectedProviderAccountId,
  ].join(":");

  // Native fieldset[disabled] freezes every nested input, combobox trigger and
  // account-chooser button while the advance POST is in flight, so mid-flight
  // edits can't desync the form from what the provider was sent. A corridor
  // blocker renders above STILL-ENABLED fields: the country select is the only
  // way out of a blocked corridor, so it must stay interactive.
  return (
    <div className="space-y-4">
      <RequirementsBlocker message={requirementsBlocker} />
      <fieldset disabled={isAdvancing} className="min-w-0">
        <RequirementsFields
          key={requirementsKey}
          provider={fields.provider}
          fields={requirementFields}
          values={collectedData}
          onChange={setCollectedField}
          payoutAccountPicker={{
            accounts: payoutAccounts,
            selectedProviderAccountId,
            onSelect: selectPayoutAccount,
          }}
        />
      </fieldset>
    </div>
  );
}

function OfframpMoneygramStep({
  wizard,
  quote,
}: {
  wizard: OfframpWizard;
  quote: Extract<NonNullable<OfframpWizard["quote"]>, { provider: "moneygram" }>;
}) {
  const {
    selectedWallet,
    quoteTransferId,
    sourceTokenMint,
    selectedRampPair,
    fields,
    refreshQuote,
    transferStatus,
  } = wizard;
  if (!selectedWallet || quoteTransferId === null) {
    return <RampQuoteSkeleton />;
  }
  return (
    <div className="space-y-6">
      <MoneygramRampWidget
        direction="offramp"
        quote={quote}
        transferId={quoteTransferId}
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

function OfframpCompleteStep({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const {
    quote,
    transferStatus,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
    onboarding,
    retryOnboarding,
  } = wizard;

  if (!quote) {
    if (quoteCreationError) {
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
      hasOnboardingLifecycle(onboarding.provider) &&
      isOnboardingPanelStatus(onboarding)
    ) {
      return (
        <RampOnboardingPanel
          direction="offramp"
          onboarding={onboarding}
          onRetry={retryOnboarding}
        />
      );
    }
    return <RampQuoteSkeleton />;
  }

  if (transferStatus?.status === "completed") {
    return <RampCompleteScreen direction="offramp" quote={quote} transfer={transferStatus} />;
  }

  if (quote.deliveryMode === "hosted") {
    return (
      <MoonpayRampFrame
        title={t("DashboardPayments.ramps.providerPayout", { provider: quote.provider })}
        src={quote.hostedUrl}
      />
    );
  }

  if (quote.provider === "moneygram") {
    return <OfframpMoneygramStep wizard={wizard} quote={quote} />;
  }

  if (quote.deliveryMode === "manual_instructions") {
    return <OfframpManualQuoteStep wizard={wizard} quote={quote} t={t} />;
  }

  return <RampQuoteSkeleton />;
}

export function OfframpStepContent({ wizard }: { wizard: OfframpWizard }) {
  switch (wizard.currentStepId) {
    case "WALLET":
      return <OfframpWalletStep wizard={wizard} />;
    case "WITHDRAW":
      return <OfframpWithdrawStep wizard={wizard} />;
    case "MEMO":
      return <MemoStepContent rows={wizard.memoRows} onChange={wizard.setMemoRows} />;
    case "REQUIREMENTS":
      return <OfframpRequirementsStep wizard={wizard} />;
    case "COMPLETE":
      return <OfframpCompleteStep wizard={wizard} />;
    default:
      return <RampQuoteSkeleton />;
  }
}
