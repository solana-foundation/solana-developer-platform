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
  Loader2,
  ShieldCheckIcon,
  WalletIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  formatMinorCurrencyAmount,
  formatRampQuoteExpiry,
  formatRampQuoteTimeRemaining,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ManualQuote = Extract<PaymentRampQuote, { deliveryMode: "manual_instructions" }>;
type LightsparkQuote = Extract<ManualQuote, { provider: "lightspark" }>;

async function copyPaymentInstruction(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`, { position: "bottom-right" });
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}.`, { position: "bottom-right" });
  }
}

function PaymentInstructionField({
  label,
  value,
  className,
}: {
  label: string;
  value?: string;
  className?: string;
}) {
  if (!value) {
    return null;
  }

  return (
    <div className={cn("rounded-xl bg-border-extra-light px-4 py-3", className)}>
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
  quote: LightsparkQuote;
  fiatCurrency: string;
  cryptoToken: string;
}) {
  const finalAmount = formatMinorCurrencyAmount(
    quote.totalReceivingAmount,
    quote.receivingCurrency.code,
    quote.receivingCurrency.decimals
  );
  const sendingAmount = formatMinorCurrencyAmount(
    quote.totalSendingAmount,
    quote.sendingCurrency.code,
    quote.sendingCurrency.decimals
  );
  const feesIncluded = formatMinorCurrencyAmount(
    quote.feesIncluded,
    quote.feeCurrency.code,
    quote.feeCurrency.decimals
  );
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

type LightsparkInstructionType = Extract<PaymentRampInstruction, { provider: "lightspark" }>;
type BvnkInstructionType = Extract<PaymentRampInstruction, { provider: "bvnk" }>;

export interface InstructionAction {
  loading: boolean;
  succeeded: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: ReactNode;
  idleLabel: string;
  busyLabel: string;
  doneLabel: string;
}

function InstructionActionButton({ action }: { action: InstructionAction }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      iconLeft={action.succeeded ? <CheckCircle2Icon /> : action.icon}
      onClick={action.onClick}
      disabled={action.disabled || action.loading || action.succeeded}
    >
      {action.succeeded ? action.doneLabel : action.loading ? action.busyLabel : action.idleLabel}
    </Button>
  );
}

function InstructionBadges({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function InstructionBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-border-extra-light px-3 py-1 text-xs font-medium text-text-medium">
      {children}
    </span>
  );
}

function LightsparkInstruction({
  instruction,
  showAction,
  action,
}: {
  instruction: LightsparkInstructionType;
  showAction: boolean;
  action?: InstructionAction;
}) {
  const info = instruction.accountOrWalletInfo;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InstructionBadges>
          <InstructionBadge>{info.accountType.replaceAll("_", " ")}</InstructionBadge>
          {info.assetType ? <InstructionBadge>{info.assetType}</InstructionBadge> : null}
        </InstructionBadges>
        {showAction && action ? <InstructionActionButton action={action} /> : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <PaymentInstructionField label="Bank name" value={info.bankName} />
        <PaymentInstructionField label="Routing number" value={info.routingNumber} />
        <PaymentInstructionField label="Account number" value={info.accountNumber} />
        <PaymentInstructionField
          label="Wallet address"
          value={info.address}
          className="lg:col-span-2"
        />
      </div>
      <PaymentInstructionField label="Reference" value={info.reference} />
      {info.paymentRails?.length ? (
        <div className="rounded-xl bg-border-extra-light px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">
            Supported rails
          </p>
          <p className="mt-1 text-sm text-text-extra-high">{info.paymentRails.join(", ")}</p>
        </div>
      ) : null}
      {instruction.instructionsNotes ? (
        <div className="rounded-xl bg-border-extra-light px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">Notes</p>
          <p className="mt-1 text-sm text-text-extra-high">{instruction.instructionsNotes}</p>
        </div>
      ) : null}
    </div>
  );
}

function BvnkCryptoDepositInstruction({
  instruction,
  action,
}: {
  instruction: Extract<BvnkInstructionType, { kind: "crypto_deposit" }>;
  action?: InstructionAction;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InstructionBadges>
          <InstructionBadge>{instruction.cryptoCurrency} deposit</InstructionBadge>
          <InstructionBadge>{instruction.network}</InstructionBadge>
        </InstructionBadges>
        {action ? <InstructionActionButton action={action} /> : null}
      </div>
      <PaymentInstructionField label="Deposit address" value={instruction.destinationAddress} />
      <PaymentInstructionField label="Reference" value={instruction.reference} />
      <div className="rounded-xl bg-border-extra-light px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">Notes</p>
        <p className="mt-1 text-sm text-text-extra-high">{instruction.instructionsNotes}</p>
      </div>
    </div>
  );
}

function BvnkInstruction({
  instruction,
  action,
}: {
  instruction: BvnkInstructionType;
  action?: InstructionAction;
}) {
  if (instruction.kind === "crypto_deposit") {
    return <BvnkCryptoDepositInstruction instruction={instruction} action={action} />;
  }

  const isReady = instruction.onboardingStatus === "ready";
  const needsVerification = instruction.onboardingStatus === "verification_required";
  const isProvisioning = instruction.onboardingStatus === "provisioning";
  const bank = instruction.bankAccount;
  const verificationUrl = instruction.verificationUrl;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InstructionBadges>
          <InstructionBadge>{instruction.fiatCurrency} virtual account</InstructionBadge>
          <InstructionBadge>{instruction.network}</InstructionBadge>
        </InstructionBadges>
        {isReady && action ? <InstructionActionButton action={action} /> : null}
      </div>

      {needsVerification ? (
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-border-extra-light text-text-extra-high">
            <ShieldCheckIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-extra-high">
                  Identity verification required
                </p>
                <p className="mt-1 text-sm leading-relaxed text-text-low">
                  {instruction.instructionsNotes}
                </p>
              </div>
              {verificationUrl ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="shrink-0"
                  onClick={() => window.open(verificationUrl, "_blank", "noopener")}
                >
                  Complete verification
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {!isReady && !needsVerification ? (
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-border-extra-light text-text-medium">
            <Clock3 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-extra-high">
              {isProvisioning
                ? "BVNK is provisioning your virtual bank account"
                : "Verification in review"}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-text-low">
              {instruction.instructionsNotes}
            </p>
            <p className="mt-3 flex items-center gap-2 text-xs font-medium text-text-medium">
              <Loader2 className="size-3.5 animate-spin" />
              {isProvisioning ? "Provisioning funding account" : "Checking verification status"}
            </p>
          </div>
        </div>
      ) : null}

      {isReady ? (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <PaymentInstructionField label="Bank name" value={bank?.bankName} />
            <PaymentInstructionField label="Account number" value={bank?.accountNumber} />
            <PaymentInstructionField label="Bank code" value={bank?.code} />
            <PaymentInstructionField label="Payment reference" value={bank?.paymentReference} />
          </div>
          <div className="rounded-xl bg-border-extra-light px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-low">Notes</p>
            <p className="mt-1 text-sm text-text-extra-high">{instruction.instructionsNotes}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ManualInstructionsQuote({
  amount,
  quote,
  fiatCurrency,
  cryptoToken,
  instructions,
  action,
  description,
}: {
  amount: string;
  quote: ManualQuote;
  fiatCurrency: string;
  cryptoToken: string;
  instructions: PaymentRampInstruction[];
  /** Button rendered in the instruction header (e.g. simulate for onramp, send for offramp). */
  action?: InstructionAction;
  /** Overrides the default fiat-deposit copy (e.g. for crypto-funded off-ramp quotes). */
  description?: string;
}) {
  const [activeTab, setActiveTab] = useState<"instructions" | "summary">("instructions");

  const instructionList = instructions.map((instruction, index) =>
    instruction.provider === "bvnk" ? (
      <BvnkInstruction
        key={
          instruction.kind === "crypto_deposit"
            ? instruction.destinationAddress
            : (instruction.ruleId ?? instruction.beneficiaryAddress)
        }
        instruction={instruction}
        action={action}
      />
    ) : (
      <LightsparkInstruction
        key={
          instruction.accountOrWalletInfo.reference ??
          instruction.accountOrWalletInfo.address ??
          "lightspark"
        }
        instruction={instruction}
        showAction={index === 0}
        action={action}
      />
    )
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-border-extra-light text-text-extra-high">
          <LandmarkIcon className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium text-text-extra-high">Manual Funding Instructions</p>
          <p className="mt-2 text-sm text-text-low">
            {description ??
              `Send ${amount ? `$${amount}` : "the quoted amount"} using one of the supported rails. Include the reference exactly so the provider can match the deposit to this quote.`}
          </p>
        </div>
      </div>

      {quote.provider === "lightspark" ? (
        <>
          <Tabs
            className="mt-6"
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

          <div className="mt-6">
            {activeTab === "instructions" ? (
              instructionList
            ) : (
              <ManualQuoteSummary
                quote={quote}
                fiatCurrency={fiatCurrency}
                cryptoToken={cryptoToken}
              />
            )}
          </div>
        </>
      ) : (
        <div className="mt-6">{instructionList}</div>
      )}
    </div>
  );
}
