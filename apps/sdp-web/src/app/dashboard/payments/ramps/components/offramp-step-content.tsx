"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { CheckCircle2Icon, SendIcon, WalletIcon, XCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { OFFRAMP_PAIRS, RAMP_PROVIDER_OPTIONS, toRampCryptoToken } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { HostedRampFrame } from "./hosted-ramp-frame";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { MoneygramRampWidget } from "./moneygram-ramp-widget";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RequirementsFields } from "./requirements-fields";
import { WalletAssetBreakdown } from "./wallet-asset-breakdown";

function getOfframpTransferStatusCopy(status: string) {
  switch (status) {
    case "pending":
    case "awaiting_payment":
      return {
        title: "Waiting to send",
        description:
          "Complete the payout using the instructions above. We will update this outgoing transfer automatically once the provider receives your crypto.",
        state: "loading" as const,
      };
    case "processing":
    case "settling":
      return {
        title: "Sending payout",
        description:
          "The provider received your crypto and is settling the outgoing payout to the recipient.",
        state: "loading" as const,
      };
    case "completed":
      return {
        title: "Payout sent",
        description:
          "The outgoing payout has settled. You can review this transfer from the counterparty record.",
        state: "success" as const,
      };
    case "failed":
      return {
        title: "Payout failed",
        description:
          "The provider reported that this outgoing payout failed. Review the counterparty record for the latest transfer status.",
        state: "error" as const,
      };
    case "expired":
      return {
        title: "Quote expired",
        description:
          "This quote expired before the payout completed. Create a new quote to continue the withdrawal.",
        state: "error" as const,
      };
    default:
      return {
        title: "Transfer status updated",
        description: `Current provider status: ${status}.`,
        state: "loading" as const,
      };
  }
}

function AnimatedDots() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const intervalId = window.setInterval(() => setCount((current) => (current % 3) + 1), 500);
    return () => window.clearInterval(intervalId);
  }, []);

  return <span aria-hidden>{".".repeat(count)}</span>;
}

function OfframpTransferStatusPanel({ transfer }: { transfer: OfframpWizard["transferStatus"] }) {
  const copy = transfer
    ? getOfframpTransferStatusCopy(transfer.status)
    : {
        title: "Preparing transfer status",
        description: "We are waiting for the transfer record tied to this quote.",
        state: "loading" as const,
      };
  const icon =
    copy.state === "success" ? (
      <CheckCircle2Icon className="size-5 text-status-success-text" />
    ) : copy.state === "error" ? (
      <XCircleIcon className="size-5 text-status-error-text" />
    ) : null;
  return (
    <div className="flex items-start gap-3">
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-extra-high">
          {copy.title}
          {copy.state === "loading" ? <AnimatedDots /> : null}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-text-low">{copy.description}</p>
      </div>
    </div>
  );
}

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
  return (
    <div className="space-y-6">
      <ManualInstructionsQuote
        amount={fields.amount.trim()}
        quote={quote}
        fiatCurrency={selectedRampPair.fiatCurrency}
        cryptoToken={cryptoToken}
        instructions={quote.paymentInstructions}
        description={`Send ${fields.amount.trim()} ${cryptoToken.toUpperCase()} to the deposit address below before the quote expires. The provider converts it at the locked rate and pays out to the saved bank account automatically.`}
        action={
          quote.provider === "lightspark"
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
            : undefined
        }
      />
      <div className="border-t border-border-light pt-5">
        <OfframpTransferStatusPanel transfer={transferStatus} />
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

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        <HostedRampFrame title={`${quote.provider} payout`} src={quote.hostedUrl} />
        <div className="border-t border-border-light pt-5">
          <OfframpTransferStatusPanel transfer={transferStatus} />
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
          <OfframpTransferStatusPanel transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "manual_instructions") {
    return <OfframpManualQuoteStep wizard={wizard} quote={quote} />;
  }

  return <RampQuoteSkeleton />;
}
