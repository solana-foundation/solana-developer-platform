"use client";

import { Combobox } from "@sdp/ui/combobox";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import type { OfframpWizard } from "@/app/dashboard/[projectId]/payments/ramps/hooks/use-offramp-wizard";
import { getRampTransferState } from "@/app/dashboard/[projectId]/payments/ramps/ramp-transfer-state";
import { walletComboboxOptions } from "@/app/dashboard/[projectId]/payments/ramps/wallet-options";
import { useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import { DemoProviderCheckout } from "./demo-provider-checkout";
import { MemoStepContent } from "./memo-step-content";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { OfframpOutcome, OfframpSendError } from "./offramp-final-step";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RampStatusPanel } from "./ramp-status-panel";
import { RequirementsFields } from "./requirements-fields";
import { WalletAssetBreakdown } from "./wallet-asset-breakdown";

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
  const { requirementFields, collectedData, setCollectedField, requirementsBlocker, isAdvancing } =
    wizard;
  return (
    <div className="space-y-4">
      <RequirementsBlocker message={requirementsBlocker} />
      <fieldset disabled={isAdvancing} className="min-w-0">
        <RequirementsFields
          fields={requirementFields}
          values={collectedData}
          onChange={setCollectedField}
        />
      </fieldset>
    </div>
  );
}

function OfframpCompleteStep({ wizard }: { wizard: OfframpWizard }) {
  const t = useTranslations();
  const demo = usePaymentsDemo();
  const { quote, transferStatus, quoteCreationError, quoteCreationRetrying, retryQuoteCreation } =
    wizard;

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
    return <RampQuoteSkeleton />;
  }

  if (transferStatus?.status === "completed") {
    return <RampCompleteScreen direction="offramp" quote={quote} transfer={transferStatus} />;
  }

  // A sale that ended another way has nothing left to do in the provider's window.
  if (transferStatus && getRampTransferState(transferStatus.status).terminal) {
    return <OfframpOutcome wizard={wizard} />;
  }

  // A provider's own page or widget can't open on sample data; the demo stands in for it.
  if (demo) {
    return (
      <div className="space-y-6">
        <DemoProviderCheckout
          direction="offramp"
          provider={quote.provider}
          transfer={transferStatus}
        />
        <div className="border-t border-border-default pt-5">
          <RampStatusPanel direction="offramp" transfer={transferStatus} />
        </div>
      </div>
    );
  }

  if (quote.deliveryMode === "hosted") {
    return (
      <div className="space-y-4">
        <OfframpSendError message={wizard.onchainSendError} />
        <MoonpayRampFrame
          title={t("DashboardPayments.ramps.providerPayout", { provider: quote.provider })}
          src={quote.hostedUrl}
        />
      </div>
    );
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
