"use client";

import { CheckCircle2Icon, Loader2Icon, WalletIcon, XCircleIcon } from "lucide-react";
import { useMemo } from "react";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Combobox } from "@/components/ui/combobox";
import { OFFRAMP_PAIRS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { HostedRampFrame } from "./hosted-ramp-frame";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampStepPlaceholder } from "./ramp-step-placeholder";

function getOfframpTransferStatusCopy(status: string) {
  switch (status) {
    case "pending":
    case "awaiting_payment":
      return {
        title: "Waiting to send",
        description:
          "Complete the payout in the widget above. We will update this outgoing transfer automatically once the provider receives your crypto.",
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
  } = wizard;

  const walletOptions = useMemo(
    () =>
      liveWallets.map((wallet) => {
        const total = wallet.balances ? resolveTotalBalance(wallet.balances) : null;
        return {
          value: wallet.walletId,
          label: wallet.label ?? wallet.walletId,
          description: total !== null ? formatCurrencyAmount(total) : undefined,
        };
      }),
    [liveWallets]
  );

  if (currentStepId === "WALLET") {
    return (
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
    );
  }

  if (currentStepId === "WITHDRAW") {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No off-ramp providers are enabled for this organization.
        </div>
      );
    }

    return (
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
    );
  }

  if (currentStepId === "COMPLETE" && quote?.deliveryMode === "hosted") {
    return (
      <div className="space-y-6">
        <HostedRampFrame title={`${quote.provider} off-ramp`} src={quote.hostedUrl} />
        <div className="border-t border-border-light pt-5">
          <OfframpTransferStatusPanel transfer={transferStatus} />
        </div>
      </div>
    );
  }

  return <RampStepPlaceholder />;
}
