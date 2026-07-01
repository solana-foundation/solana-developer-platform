"use client";

import type { CoinbaseRampEvent } from "@sdp/types";
import { DollarSignIcon } from "lucide-react";
import { toast } from "sonner";
import { postCoinbaseRampEvent } from "@/app/dashboard/payments/payments-workspace.data";
import { ONRAMP_PAIRS, RAMP_PROVIDER_OPTIONS, toRampCryptoToken } from "@/lib/ramps";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { HostedRampFrame, type HostedRampFrameEvent } from "./hosted-ramp-frame";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { hasOnboardingLifecycle, simulateActionLabels } from "./providers";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";

// Coinbase headless iframe postMessage names → SDP ramp event kinds. Unmapped names (load_*, cancel) are ignored.
const COINBASE_EVENT_KIND = {
  "onramp_api.commit_success": "committed",
  "onramp_api.polling_success": "completed",
  "onramp_api.commit_error": "errored",
  "onramp_api.polling_error": "errored",
} as const satisfies Record<string, CoinbaseRampEvent["kind"]>;

function reportCoinbaseFrameEvent(orderId: string, frameEvent: HostedRampFrameEvent): void {
  const kind = COINBASE_EVENT_KIND[frameEvent.eventName as keyof typeof COINBASE_EVENT_KIND];
  if (!kind) {
    return;
  }
  const event: CoinbaseRampEvent =
    kind === "errored"
      ? {
          kind,
          orderId,
          reason: frameEvent.data?.errorMessage
            ? frameEvent.data.errorMessage
            : frameEvent.eventName,
        }
      : { kind, orderId };
  postCoinbaseRampEvent(event).catch((error) => {
    toast.error("Failed to record Coinbase event.", {
      description: error instanceof Error ? error.message : "Event request failed.",
      position: "bottom-right",
    });
  });
}

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
        <HostedRampFrame
          title={`${quote.provider} deposit`}
          src={quote.hostedUrl}
          {...(quote.provider === "coinbase"
            ? {
                onProviderEvent: (frameEvent: HostedRampFrameEvent) =>
                  reportCoinbaseFrameEvent(quote.id, frameEvent),
                // Required by Coinbase to render the Apple Pay payment link in an iframe.
                sandbox: "allow-scripts allow-same-origin",
                referrerPolicy: "no-referrer" as const,
              }
            : {})}
        />
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
