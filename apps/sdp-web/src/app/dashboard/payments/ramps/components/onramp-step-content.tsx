"use client";

import type { PaymentRampInstruction, PaymentRampQuote } from "@sdp/types";
import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import {
  ArrowDownLeft,
  CheckCircle2Icon,
  Clock3,
  CoinsIcon,
  CopyIcon,
  DollarSignIcon,
  LandmarkIcon,
  PlusIcon,
  WalletIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ONRAMP_PAIRS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";
import {
  formatMinorCurrencyAmount,
  formatRampQuoteExpiry,
  formatRampQuoteTimeRemaining,
} from "../../payments-overview.utils";
import { type OnrampWizard, toRampCryptoToken } from "../../use-onramp-wizard";
import { CounterpartySelector } from "./counterparty-selector";
import { RampPairProviderSelector } from "./ramp-pair-provider-selector";

async function copyPaymentInstruction(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`, {
      position: "bottom-right",
    });
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}.`, {
      position: "bottom-right",
    });
  }
}

function PaymentInstructionField({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-xl bg-border-extra-light px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">{label}</p>
          <p className="mt-1 break-all font-mono text-sm text-text-extra-high">{value}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          iconLeft={<CopyIcon />}
          onClick={() => void copyPaymentInstruction(label, value)}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function QuoteSummaryField({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value?: string | null;
}) {
  if (!value) {
    return null;
  }

  return (
    <div className="flex items-start gap-3 rounded-xl bg-border-extra-light px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-text-medium">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">{label}</p>
        <p className="mt-1 break-all text-sm font-medium text-text-extra-high">{value}</p>
      </div>
    </div>
  );
}

function QuoteExpiryTabLabel({ expiresAt }: { expiresAt?: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timeRemaining = formatRampQuoteTimeRemaining(expiresAt, nowMs);

  useEffect(() => {
    if (!expiresAt) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [expiresAt]);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Instructions</span>
      {timeRemaining ? (
        <span className="rounded-full bg-border-extra-light px-2 py-0.5 text-[11px] font-medium text-text-medium">
          {timeRemaining}
        </span>
      ) : null}
    </span>
  );
}

function ManualQuoteSummary({
  quote,
  fiatCurrency,
  cryptoToken,
}: {
  quote: Extract<PaymentRampQuote, { deliveryMode: "manual_instructions" }>;
  fiatCurrency: string;
  cryptoToken: string;
}) {
  const finalAmount = formatMinorCurrencyAmount(quote.totalReceivingAmount, cryptoToken);
  const sendingAmount = formatMinorCurrencyAmount(quote.totalSendingAmount, fiatCurrency);
  const feesIncluded = formatMinorCurrencyAmount(quote.feesIncluded, fiatCurrency);
  const exchangeRate =
    quote.exchangeRate !== undefined
      ? `1 ${fiatCurrency.toUpperCase()} = ${quote.exchangeRate} ${cryptoToken.toUpperCase()}`
      : null;
  const expiresAt = formatRampQuoteExpiry(quote.expiresAt);

  if (!finalAmount && !sendingAmount && !feesIncluded && !exchangeRate && !expiresAt) {
    return null;
  }

  return (
    <div className="space-y-4 text-left">
      <div>
        <p className="text-sm font-medium text-text-extra-high">Quote Summary</p>
        <p className="mt-1 text-sm text-text-low">Locked pricing for this funding instruction.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <QuoteSummaryField
          icon={<CoinsIcon className="size-4" />}
          label="Final amount"
          value={finalAmount}
        />
        <QuoteSummaryField
          icon={<WalletIcon className="size-4" />}
          label="Deposit amount"
          value={sendingAmount}
        />
        <QuoteSummaryField
          icon={<DollarSignIcon className="size-4" />}
          label="Fees included"
          value={feesIncluded}
        />
        <QuoteSummaryField
          icon={<ArrowDownLeft className="size-4" />}
          label="Exchange rate"
          value={exchangeRate}
        />
        <QuoteSummaryField icon={<Clock3 className="size-4" />} label="Expires" value={expiresAt} />
      </div>
    </div>
  );
}

function ManualInstructionsQuote({
  amount,
  quote,
  fiatCurrency,
  cryptoToken,
  instructions,
  simulateQuote,
}: {
  amount: string;
  quote: Extract<PaymentRampQuote, { deliveryMode: "manual_instructions" }>;
  fiatCurrency: string;
  cryptoToken: string;
  instructions: PaymentRampInstruction[];
  simulateQuote?: {
    loading: boolean;
    succeeded: boolean;
    onClick: () => void;
  };
}) {
  const [activeTab, setActiveTab] = useState<"instructions" | "summary">("instructions");

  return (
    <div className="max-h-[70vh] space-y-6 overflow-y-auto">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-border-extra-light text-text-extra-high">
          <LandmarkIcon className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium text-text-extra-high">Manual Funding Instructions</p>
          <p className="mt-2 text-sm text-text-low">
            Send {amount ? `$${amount}` : "the quoted amount"} using one of the supported rails.
            Include the reference exactly so the provider can match the deposit to this quote.
          </p>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "instructions" || value === "summary") {
            setActiveTab(value);
          }
        }}
      >
        <TabList>
          <Tab value="instructions">
            <QuoteExpiryTabLabel expiresAt={quote.expiresAt} />
          </Tab>
          <Tab value="summary">Quote Summary</Tab>
        </TabList>
      </Tabs>

      {activeTab === "instructions" ? (
        instructions.map((instruction, index) => {
          const info = instruction.accountOrWalletInfo;
          return (
            <div
              key={`${info.reference ?? info.accountNumber ?? info.address ?? index}`}
              className="space-y-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-border-extra-light px-3 py-1 text-xs font-medium text-text-medium">
                    {info.accountType.replaceAll("_", " ")}
                  </span>
                  {info.assetType ? (
                    <span className="rounded-full bg-border-extra-light px-3 py-1 text-xs font-medium text-text-medium">
                      {info.assetType}
                    </span>
                  ) : null}
                </div>
                {index === 0 && simulateQuote ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    iconLeft={simulateQuote.succeeded ? <CheckCircle2Icon /> : <DollarSignIcon />}
                    onClick={simulateQuote.onClick}
                    disabled={simulateQuote.loading || simulateQuote.succeeded}
                  >
                    {simulateQuote.succeeded
                      ? "Quote Simulated"
                      : simulateQuote.loading
                        ? "Simulating..."
                        : "Simulate Quote"}
                  </Button>
                ) : null}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <PaymentInstructionField label="Bank name" value={info.bankName} />
                <PaymentInstructionField label="Routing number" value={info.routingNumber} />
                <PaymentInstructionField label="Account number" value={info.accountNumber} />
                <PaymentInstructionField label="Wallet address" value={info.address} />
              </div>
              <PaymentInstructionField label="Reference" value={info.reference} />
              {info.paymentRails?.length ? (
                <div className="rounded-xl bg-border-extra-light px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">
                    Supported rails
                  </p>
                  <p className="mt-1 text-sm text-text-extra-high">
                    {info.paymentRails.join(", ")}
                  </p>
                </div>
              ) : null}
              {instruction.instructionsNotes ? (
                <div className="rounded-xl bg-border-extra-light px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">
                    Notes
                  </p>
                  <p className="mt-1 text-sm text-text-extra-high">
                    {instruction.instructionsNotes}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <ManualQuoteSummary quote={quote} fiatCurrency={fiatCurrency} cryptoToken={cryptoToken} />
      )}
    </div>
  );
}

export function OnrampStepContent({ wizard }: { wizard: OnrampWizard }) {
  const {
    stepIndex,
    enabledRampProviders,
    liveCounterpartiesResult,
    onrampFields,
    setField,
    setCounterpartyDialogOpen,
    liveWallets,
    walletsLoading,
    selectedWallet,
    selectedRampPair,
    onrampQuote,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
    handlePairChange,
  } = wizard;

  if (stepIndex === 0) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setCounterpartyDialogOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-light px-4 py-3.5 text-left transition-colors hover:border-border-medium hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
            <PlusIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-text-extra-high">Add counterparty</span>
            <span className="block text-sm text-text-low">
              Create a new buyer to deposit for if they aren&apos;t in the list yet.
            </span>
          </span>
        </button>
        <CounterpartySelector
          counterpartiesResult={liveCounterpartiesResult}
          value={onrampFields.counterpartyId || null}
          onChange={(id) => setField("counterpartyId", id)}
        />
      </div>
    );
  }

  if (stepIndex === 1) {
    if (enabledRampProviders.length === 0) {
      return (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No on-ramp providers are enabled for this organization.
        </div>
      );
    }

    return (
      <RampPairProviderSelector
        direction="onramp"
        pairs={ONRAMP_PAIRS}
        enabledRampProviders={enabledRampProviders}
        providerOptions={RAMP_PROVIDER_OPTIONS}
        wallets={liveWallets}
        walletsLoading={walletsLoading}
        selectedWallet={selectedWallet}
        selectedPair={selectedRampPair}
        selectedProvider={onrampFields.provider}
        amount={onrampFields.amount}
        onAmountChange={(value) => setField("amount", value)}
        onAmountBlur={() => {}}
        onWalletChange={(walletId) => setField("walletId", walletId)}
        onPairChange={handlePairChange}
        onProviderSelect={(nextProvider) => setField("provider", nextProvider)}
      />
    );
  }

  if (stepIndex === 2 && onrampQuote?.deliveryMode === "hosted") {
    return (
      <div className="overflow-hidden rounded-2xl">
        <iframe
          title={`${onrampQuote.provider} on-ramp`}
          src={onrampQuote.hostedUrl}
          className="h-[480px] w-full border-0"
          allow="accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment"
        />
      </div>
    );
  }

  if (stepIndex === 2 && onrampQuote?.deliveryMode === "manual_instructions") {
    return (
      <ManualInstructionsQuote
        amount={onrampFields.amount.trim()}
        quote={onrampQuote}
        fiatCurrency={selectedRampPair.fiatCurrency}
        cryptoToken={toRampCryptoToken(selectedRampPair.assetRail)}
        instructions={onrampQuote.paymentInstructions ?? []}
        simulateQuote={
          onrampQuote.provider === "lightspark"
            ? {
                loading: quoteSimulationLoading,
                succeeded: quoteSimulationSucceeded,
                onClick: () => void simulateCurrentQuote(),
              }
            : undefined
        }
      />
    );
  }

  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border-light bg-border-extra-light px-6 py-16 text-center">
      <p className="text-lg font-medium text-text-extra-high">Coming soon</p>
      <p className="mt-1 text-sm text-text-low">This step isn&apos;t built yet.</p>
    </div>
  );
}
