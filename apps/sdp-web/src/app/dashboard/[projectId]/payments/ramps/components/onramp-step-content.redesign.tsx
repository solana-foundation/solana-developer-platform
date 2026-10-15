"use client";

import { useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { hasEnabledRampProvider } from "@/lib/provider-availability";
import type { OnrampWizard } from "../hooks/use-onramp-wizard.redesign";
import { ContactCombobox, type ContactControls } from "./contact-combobox";
import { DemoProviderCheckout } from "./demo-provider-checkout";
import { MemoStepContent } from "./memo-step-content.redesign";
import { MoonpayRampFrame } from "./moonpay-ramp-frame";
import { OnrampReview } from "./onramp-review";
import { RampCompleteScreen } from "./ramp-complete-screen";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector.redesign";
import { RampQuoteError } from "./ramp-quote-error";
import { RampQuoteSkeleton } from "./ramp-quote-skeleton";
import { RequirementsFields } from "./requirements-fields";
import { StripeOnrampFrame } from "./stripe-onramp-frame";

interface StepContentProps {
  wizard: OnrampWizard;
  /** Deposit picks its contact on the details step; omitted when it was picked before. */
  contact?: ContactControls;
}

type OnrampQuote = NonNullable<OnrampWizard["quote"]>;
type HostedQuoteRecord = Extract<OnrampQuote, { deliveryMode: "hosted" }>;

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

/** Renders the fields requested by the active provider. */
function RequirementsStep({ wizard }: { wizard: OnrampWizard }) {
  const { isAdvancing, requirementFields, collectedData, setCollectedField } = wizard;
  return (
    <fieldset disabled={isAdvancing} className="min-w-0">
      <RequirementsFields
        fields={requirementFields}
        values={collectedData}
        onChange={setCollectedField}
      />
    </fieldset>
  );
}

/** A provider's hosted checkout. */
function HostedQuoteStep({ quote }: { quote: HostedQuoteRecord }) {
  const t = useTranslations();
  return (
    <MoonpayRampFrame
      title={t("DashboardPayments.ramps.providerDeposit", { provider: quote.provider })}
      src={quote.hostedUrl}
    />
  );
}

/**
 * The provider step once its quote exists: the outcome once the transfer is done, otherwise the
 * quote's own surface (a hosted frame, a widget, bank instructions).
 */
function QuoteStep({ wizard, quote }: { wizard: OnrampWizard; quote: OnrampQuote }) {
  const demo = usePaymentsDemo();
  const { transferStatus } = wizard;

  if (wizard.showCompleteScreen) {
    if (transferStatus === undefined) {
      return <RampQuoteSkeleton />;
    }
    return <RampCompleteScreen direction="onramp" quote={quote} transfer={transferStatus} />;
  }

  // A provider's own checkout can't open on sample data; the demo stands in for it.
  if (demo) {
    return (
      <div className="space-y-6">
        <DemoProviderCheckout
          direction="onramp"
          provider={quote.provider}
          transfer={transferStatus}
        />
      </div>
    );
  }

  if (quote.provider === "stripe") {
    return (
      <StripeOnrampFrame clientSecret={quote.clientSecret} publishableKey={quote.publishableKey} />
    );
  }

  if (quote.deliveryMode === "hosted") {
    return <HostedQuoteStep quote={quote} />;
  }

  return <RampQuoteSkeleton />;
}

/**
 * The provider step: the quote's own surface (a hosted frame, a widget, bank instructions),
 * the onboarding or error that stands in its way, or the outcome once the transfer is done.
 */
function ProviderStep({ wizard }: { wizard: OnrampWizard }) {
  const { quote, quoteCreationError, quoteCreationRetrying, retryQuoteCreation } = wizard;

  if (quote) {
    return <QuoteStep wizard={wizard} quote={quote} />;
  }

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
