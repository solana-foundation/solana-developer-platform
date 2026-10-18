"use client";

import { Combobox } from "@sdp/ui/combobox";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { MemoStepContent } from "./memo-step-content";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RequirementsFields } from "./requirements-fields";
import { WalletAssetBreakdown } from "./wallet-asset-breakdown";

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
    selectProvider,
    handlePairChange,
    requirementFields,
    collectedData,
    setCollectedField,
    requirementsBlocker,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
    isAdvancing,
    memoRows,
    setMemoRows,
    sourceWalletHint,
  } = wizard;

  const walletOptions = useMemo(
    () =>
      walletComboboxOptions(liveWallets, t("DashboardPayments.restricted"), {
        disableRestricted: true,
      }),
    [liveWallets, t]
  );

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
        <p hidden={!sourceWalletHint} className="text-sm text-warning">
          {sourceWalletHint}
        </p>
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

  if (currentStepId === "MEMO") {
    return <MemoStepContent rows={memoRows} onChange={setMemoRows} />;
  }

  if (currentStepId === "REQUIREMENTS") {
    return (
      <div className="space-y-4">
        {requirementsBlocker ? (
          <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
            {requirementsBlocker}
          </div>
        ) : null}
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

  if (currentStepId === "COMPLETE" && !quote && quoteCreationError) {
    return (
      <RampQuoteError
        error={quoteCreationError}
        retrying={quoteCreationRetrying}
        onRetry={() => void retryQuoteCreation()}
      />
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

  return <RampQuoteSkeleton />;
}
