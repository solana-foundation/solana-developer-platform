"use client";

import {
  CheckCircle2Icon,
  DollarSignIcon,
  Loader2Icon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import {
  formatMinorCurrencyAmount,
  formatTimestamp,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import {
  getRampProviderLabel,
  ONRAMP_PAIRS,
  RAMP_PROVIDER_OPTIONS,
  toRampCryptoToken,
} from "@/lib/ramps";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { HostedRampFrame } from "./hosted-ramp-frame";
import { ManualInstructionsQuote } from "./manual-instructions-quote";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RequirementsFields } from "./requirements-fields";

function getOnrampTransferStatusCopy(status: string) {
  switch (status) {
    case "pending":
    case "awaiting_payment":
      return {
        title: "Waiting for funding",
        description:
          "Send the funds using the instructions above. We will update this deposit automatically once the provider receives payment.",
        state: "loading" as const,
      };
    case "processing":
    case "settling":
      return {
        title: "Deposit received",
        description:
          "The provider has received funds and is settling the deposit to the destination wallet.",
        state: "loading" as const,
      };
    case "completed":
      return {
        title: "Transfer complete",
        description:
          "The deposit is complete. You can review the transfer from the counterparty record.",
        state: "success" as const,
      };
    case "failed":
      return {
        title: "Transfer failed",
        description:
          "The provider reported that this deposit failed. Review the counterparty record for the latest transfer status.",
        state: "error" as const,
      };
    case "expired":
      return {
        title: "Quote expired",
        description:
          "This quote expired before the transfer completed. Create a new quote to continue funding.",
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

function OnrampTransferStatusPanel({ transfer }: { transfer: OnrampWizard["transferStatus"] }) {
  const copy = transfer
    ? getOnrampTransferStatusCopy(transfer.status)
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
    ) : (
      <Loader2Icon className="size-5 animate-spin text-text-medium" />
    );
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-extra-high">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-text-low">
          {copy.description}
          {copy.state === "loading" ? " Checking transfer status…" : null}
        </p>
      </div>
    </div>
  );
}

function TransferDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="shrink-0 text-sm text-text-low">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-text-extra-high">
        {value}
      </span>
    </div>
  );
}

function OnrampCompleteScreen({
  quote,
  transfer,
}: {
  quote: NonNullable<OnrampWizard["quote"]>;
  transfer: NonNullable<OnrampWizard["transferStatus"]>;
}) {
  const receivedAmount =
    transfer.amount && transfer.token ? `${transfer.amount} ${transfer.token.toUpperCase()}` : null;
  const fundedAmount =
    transfer.fiatAmount && transfer.fiatCurrency
      ? `${transfer.fiatAmount} ${transfer.fiatCurrency.toUpperCase()}`
      : null;

  const detailRows: { label: string; value: string }[] = [];
  if (!receivedAmount && fundedAmount) {
    detailRows.push({ label: "Funded", value: fundedAmount });
  }
  detailRows.push({ label: "Provider", value: getRampProviderLabel(quote.provider) });

  if (quote.provider === "lightspark") {
    const sendingAmount = formatMinorCurrencyAmount(
      quote.totalSendingAmount,
      quote.sendingCurrency.code,
      quote.sendingCurrency.decimals
    );
    const receivingAmount = formatMinorCurrencyAmount(
      quote.totalReceivingAmount,
      quote.receivingCurrency.code,
      quote.receivingCurrency.decimals
    );
    if (sendingAmount) {
      detailRows.push({ label: "Final funded amount", value: sendingAmount });
    }
    if (receivingAmount) {
      detailRows.push({ label: "Final received amount", value: receivingAmount });
    }
  }

  if (transfer.updatedAt) {
    detailRows.push({ label: "Completed", value: formatTimestamp(transfer.updatedAt) });
  }
  detailRows.push({ label: "Transfer ID", value: transfer.id });
  detailRows.push({ label: "Quote ID", value: quote.id });

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex size-16 items-center justify-center rounded-full bg-status-success-bg text-status-success-text">
        <CheckCircle2Icon className="size-8" />
      </div>
      <div className="space-y-1 text-center">
        <p className="text-2xl font-medium tracking-tight text-text-extra-high">Deposit complete</p>
        <p className="text-sm text-text-low">The funds have settled to the destination wallet.</p>
      </div>
      <section className="w-full space-y-4 rounded-2xl bg-border-extra-light p-5">
        {receivedAmount ? (
          <div className="flex flex-col items-center gap-0.5 border-b border-border-light pb-4">
            <p className="text-3xl font-semibold tracking-tight text-text-extra-high">
              {receivedAmount}
            </p>
            {fundedAmount ? (
              <p className="text-sm text-text-low">funded with {fundedAmount}</p>
            ) : null}
          </div>
        ) : null}
        <div>
          {detailRows.map((detail) => (
            <TransferDetailRow key={detail.label} label={detail.label} value={detail.value} />
          ))}
        </div>
      </section>
    </div>
  );
}

function OnboardingErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <XCircleIcon className="size-10 text-status-error-text" />
      <p className="text-lg font-medium text-text-extra-high">
        We couldn't finish setting up your account
      </p>
      <p className="max-w-md text-sm leading-relaxed text-text-low">
        Something went wrong provisioning your funding account. Please try again.
      </p>
      <Button type="button" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function OnboardingVerificationFailedPanel() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <XCircleIcon className="size-10 text-status-error-text" />
      <p className="text-lg font-medium text-text-extra-high">
        Identity verification was not approved
      </p>
      <p className="max-w-md text-sm leading-relaxed text-text-low">
        BVNK couldn't verify your identity, so this funding account can't be activated. Contact
        support if you believe this is a mistake.
      </p>
    </div>
  );
}

function OnboardingPanel({
  onboarding,
  onRetry,
}: {
  onboarding: NonNullable<OnrampWizard["onboarding"]>;
  onRetry: () => void;
}) {
  switch (onboarding.status) {
    case "provisioning_failed":
      return <OnboardingErrorPanel onRetry={onRetry} />;
    case "customer_verification_failed":
      return <OnboardingVerificationFailedPanel />;
    default:
      return <OnboardingPendingPanel status={onboarding.status} />;
  }
}

function OnboardingPendingPanel({
  status,
}: {
  status: NonNullable<OnrampWizard["onboarding"]>["status"];
}) {
  const needsVerification = status === "customer_verification_required";
  let title: string;
  let description: string;
  switch (status) {
    case "customer_verification_required":
      title = "Verify your identity";
      description =
        "BVNK partners with Sumsub to confirm your identity before activating your funding account. Hit “Complete Verification” below to get started — this page refreshes automatically once you're approved, and your deposit instructions will appear right here.";
      break;
    case "customer_verifying":
      title = "Verification in review";
      description =
        "Sumsub is reviewing your details — this usually takes just a few minutes. Feel free to come back later; your deposit instructions will show up here as soon as you're approved.";
      break;
    case "ready":
      title = "Preparing your deposit instructions";
      description = "Your funding account is ready — fetching your deposit details now.";
      break;
    default:
      title = "Setting up your funding account";
      description =
        "Almost there — we're provisioning your virtual account now. Your deposit instructions will appear here in a moment.";
  }
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      {needsVerification ? (
        <ShieldCheckIcon className="size-10 text-text-extra-high" />
      ) : (
        <Loader2Icon className="size-10 animate-spin text-text-medium" />
      )}
      <p className="text-lg font-medium text-text-extra-high">{title}</p>
      <p className="max-w-md text-sm leading-relaxed text-text-low">{description}</p>
    </div>
  );
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

  if (currentStepId === "PROVIDER" && onboarding && !quote) {
    return <OnboardingPanel onboarding={onboarding} onRetry={retryOnboarding} />;
  }

  if (currentStepId === "PROVIDER" && quote) {
    if (transferStatus && transferStatus.status === "completed") {
      return <OnrampCompleteScreen quote={quote} transfer={transferStatus} />;
    }
  }

  if (currentStepId === "PROVIDER" && quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        <HostedRampFrame title={`${quote.provider} deposit`} src={quote.hostedUrl} />
        <div className="border-t border-border-light pt-5">
          <OnrampTransferStatusPanel transfer={transferStatus} />
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

    return (
      <div className="space-y-6">
        <ManualInstructionsQuote
          amount={fields.amount.trim()}
          quote={quote}
          fiatCurrency={selectedRampPair.fiatCurrency}
          cryptoToken={toRampCryptoToken(selectedRampPair.assetRail)}
          instructions={quote.paymentInstructions}
          action={
            quote.provider === "lightspark" || quote.provider === "bvnk"
              ? {
                  loading: quoteSimulationLoading,
                  succeeded: quoteSimulationSucceeded,
                  onClick: () => void simulateCurrentQuote(),
                  icon: <DollarSignIcon />,
                  idleLabel: quote.provider === "bvnk" ? "Simulate Deposit" : "Simulate Quote",
                  busyLabel: "Simulating...",
                  doneLabel: quote.provider === "bvnk" ? "Deposit Simulated" : "Quote Simulated",
                }
              : undefined
          }
        />
        <div className="border-t border-border-light pt-5">
          <OnrampTransferStatusPanel transfer={transferStatus} />
        </div>
      </div>
    );
  }

  return <RampQuoteSkeleton />;
}
