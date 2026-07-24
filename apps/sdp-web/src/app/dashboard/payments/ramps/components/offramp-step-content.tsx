"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { SendIcon, WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import { toRampCryptoToken } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { MetadataField } from "./metadata-field";
import { MoneygramRampWidget } from "./moneygram-ramp-widget";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { hasOnboardingLifecycle } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
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
  const {
    selectedRampPair,
    fields,
    transferStatus,
    hasCryptoDepositInstruction,
    canSendOnchain,
    onchainSendLoading,
    onchainSendResult,
    sendCryptoToDeposit,
    quoteExpired,
  } = wizard;

  if (!quote.paymentInstructions) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.quoteMissingInstructions")}
      </div>
    );
  }

  const cryptoToken = toRampCryptoToken(selectedRampPair.assetRail);
  const sendLabel = t("DashboardPayments.ramps.sendCrypto", {
    amount: fields.amount.trim(),
    token: cryptoToken.toUpperCase(),
  });
  const sendAction = hasCryptoDepositInstruction
    ? {
        loading: onchainSendLoading,
        succeeded: onchainSendResult !== null,
        disabled: !canSendOnchain || quoteExpired,
        onClick: () => void sendCryptoToDeposit(),
        icon: <SendIcon />,
        idleLabel: quoteExpired ? t("DashboardPayments.ramps.quoteExpired") : sendLabel,
        busyLabel: t("DashboardPayments.ramps.sending"),
        doneLabel: t("DashboardPayments.ramps.transferSubmitted"),
      }
    : undefined;

  return (
    <div className="space-y-6">
      <ManualInstructionsQuote
        amount={fields.amount.trim()}
        quote={quote}
        fiatCurrency={selectedRampPair.fiatCurrency}
        cryptoToken={cryptoToken}
        instructions={quote.paymentInstructions}
        description={t("DashboardPayments.ramps.offrampManualDescription", {
          amount: fields.amount.trim(),
          token: cryptoToken.toUpperCase(),
        })}
        action={sendAction}
      />
      <div className="border-t border-border-default pt-5">
        <RampStatusPanel direction="offramp" transfer={transferStatus} />
      </div>
    </div>
  );
}

export function OfframpStepContent({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const {
    currentStepId,
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
    collectedData,
    setCollectedField,
    requirementsBlocker,
    sourceTokenMint,
    refreshQuote,
    onboarding,
    retryOnboarding,
    metadata,
    setMetadata,
  } = wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);

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
        <MetadataField metadata={metadata} onChange={setMetadata} />
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
    currentStepId === "COMPLETE" &&
    onboarding &&
    !quote &&
    hasOnboardingLifecycle(onboarding.provider)
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
      <div className="space-y-6">
        <MoonpayRampFrame
          title={t("DashboardPayments.ramps.providerPayout", { provider: quote.provider })}
          src={quote.hostedUrl}
        />
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="offramp" transfer={transferStatus} />
        </div>
      </div>
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
          counterparty={selectedCounterparty}
          sourceWalletId={fields.walletId}
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
