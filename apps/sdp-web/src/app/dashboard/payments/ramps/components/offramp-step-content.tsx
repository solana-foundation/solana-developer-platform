"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { SendIcon, WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import { OFFRAMP_PAIRS, RAMP_PROVIDER_OPTIONS, toRampCryptoToken } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
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

function OfframpManualQuoteStep({
  wizard,
  quote,
}: {
  wizard: OfframpWizard;
  quote: Extract<NonNullable<OfframpWizard["quote"]>, { deliveryMode: "manual_instructions" }>;
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
      <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-5 py-5 text-sm text-status-error-text">
        Ramp quote is missing payment instructions.
      </div>
    );
  }

  const cryptoToken = toRampCryptoToken(selectedRampPair.assetRail);
  const sendLabel = `Send ${fields.amount.trim()} ${cryptoToken.toUpperCase()}`;
  const sendAction = hasCryptoDepositInstruction
    ? {
        loading: onchainSendLoading,
        succeeded: onchainSendResult !== null,
        disabled: !canSendOnchain || quoteExpired,
        onClick: () => void sendCryptoToDeposit(),
        icon: <SendIcon />,
        idleLabel: quoteExpired ? "Quote expired" : sendLabel,
        busyLabel: "Sending...",
        doneLabel: "Transfer submitted",
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
        description={`Send ${fields.amount.trim()} ${cryptoToken.toUpperCase()} to the deposit address below before the quote expires. The provider converts it at the locked rate and pays out to the saved bank account automatically.`}
        action={sendAction}
      />
      <div className="border-t border-border-light pt-5">
        <RampStatusPanel direction="offramp" transfer={transferStatus} />
      </div>
    </div>
  );
}

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
    transferStatus,
    setField,
    handlePairChange,
    requirementFields,
    collectedData,
    setCollectedField,
    requirementsBlocker,
    sourceTokenMint,
    refreshQuote,
    liveCounterpartiesResult,
    onboarding,
    retryOnboarding,
  } = wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);
  const selectedCounterparty = useMemo(
    () =>
      liveCounterpartiesResult?.data.find(
        (counterparty) => counterparty.id === fields.counterpartyId
      ) ?? null,
    [liveCounterpartiesResult, fields.counterpartyId]
  );

  if (currentStepId === "WALLET") {
    return (
      <div className="space-y-4">
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
        {selectedWallet ? <WalletAssetBreakdown wallet={selectedWallet} /> : null}
      </div>
    );
  }

  if (currentStepId === "WITHDRAW") {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No payout providers are enabled for this organization.
        </div>
      );
    }

    return (
      <div className="space-y-4">
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
        <MoonpayRampFrame title={`${quote.provider} payout`} src={quote.hostedUrl} />
        <div className="border-t border-border-light pt-5">
          <RampStatusPanel direction="offramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "session_widget") {
    if (!selectedWallet) {
      return <RampQuoteSkeleton />;
    }
    return (
      <div className="space-y-6">
        <MoneygramRampWidget
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
        <div className="border-t border-border-light pt-5">
          <RampStatusPanel direction="offramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "manual_instructions") {
    return <OfframpManualQuoteStep wizard={wizard} quote={quote} />;
  }

  return <RampQuoteSkeleton />;
}
