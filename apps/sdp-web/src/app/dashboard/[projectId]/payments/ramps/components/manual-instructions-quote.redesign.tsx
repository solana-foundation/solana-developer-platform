"use client";

import type { PaymentRampInstruction, PaymentRampQuote } from "@sdp/types";
import {
  CheckCircle2Icon,
  Clock3,
  CopyIcon,
  LandmarkIcon,
  Loader2,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { formatDecimalAmount } from "@/app/dashboard/[projectId]/payments/payments-presentation";
import { useThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { cn } from "@/lib/utils";

type ManualQuote = Extract<PaymentRampQuote, { deliveryMode: "manual_instructions" }>;

async function copyPaymentInstruction(
  label: string,
  value: string,
  t: ReturnType<typeof useTranslations>
) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(t("DashboardPayments.manualInstructions.copied", { label }), {
      position: "bottom-right",
    });
  } catch {
    toast.error(
      t("DashboardPayments.manualInstructions.copyFailed", { label: label.toLowerCase() }),
      { position: "bottom-right" }
    );
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
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  if (!value) {
    return null;
  }

  if (refresh) {
    // A plain row: label, value, copy icon, the way the design lays out account details.
    return (
      <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-3.5">
        <span className="text-body text-secondary">{label}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 break-all text-right text-body text-primary">{value}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("DashboardPayments.manualInstructions.copyLabel", { label })}
            onClick={() => void copyPaymentInstruction(label, value, t)}
          >
            <CopyIcon className="size-3.5" />
          </Button>
        </span>
      </div>
    );
  }

  return (
    // react-doctor-disable-next-line duplicate-jsx-subtree -- redesign sibling of main's manual-instructions-quote.tsx; goes away when the old design is removed
    <div className={cn("rounded-xl bg-fill-subtle px-4 py-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-tertiary">{label}</p>
          <p className="mt-1 break-all font-mono text-sm text-primary">{value}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          iconLeft={<CopyIcon />}
          onClick={() => void copyPaymentInstruction(label, value, t)}
        >
          {t("DashboardPayments.manualInstructions.copy")}
        </Button>
      </div>
    </div>
  );
}

export function QuoteSummaryField({
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
    <div className="flex items-start gap-3 rounded-xl bg-fill-subtle px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-tertiary">{label}</p>
        <p className="mt-1 break-all text-sm font-medium text-primary">{value}</p>
      </div>
    </div>
  );
}

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

export function InstructionActionButton({
  action,
  variant = "secondary",
  size = "xs",
}: {
  action: InstructionAction;
  variant?: "default" | "secondary";
  size?: "default" | "xs";
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
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
    <span className="rounded-full bg-fill-subtle px-3 py-1 text-xs font-medium text-secondary">
      {children}
    </span>
  );
}

/** An instruction's badges with its action, when it has one, at the trailing edge. */
function InstructionHeader({
  action,
  children,
}: {
  action?: InstructionAction;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <InstructionBadges>{children}</InstructionBadges>
      {action ? <InstructionActionButton action={action} /> : null}
    </div>
  );
}

/** The provider's free-text notes under an instruction. */
function InstructionNotes({ children }: { children: ReactNode }) {
  const t = useTranslations();
  return (
    <div className="rounded-xl bg-fill-subtle px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-tertiary">
        {t("DashboardPayments.manualInstructions.notes")}
      </p>
      <p className="mt-1 text-sm text-primary">{children}</p>
    </div>
  );
}

/** The square icon tile that leads the funding header and BVNK's verification notices. */
function InstructionIconTile({
  tone,
  children,
}: {
  tone: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle",
        tone === "primary" ? "text-primary" : "text-secondary"
      )}
    >
      {children}
    </span>
  );
}

function BvnkCryptoDepositInstruction({
  instruction,
  action,
}: {
  instruction: Extract<BvnkInstructionType, { kind: "crypto_deposit" }>;
  action?: InstructionAction;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <InstructionHeader action={action}>
        <InstructionBadge>
          {t("DashboardPayments.manualInstructions.cryptoDeposit", {
            currency: instruction.cryptoCurrency,
          })}
        </InstructionBadge>
        <InstructionBadge>{instruction.network}</InstructionBadge>
      </InstructionHeader>
      <PaymentInstructionField
        label={t("DashboardPayments.manualInstructions.depositAddress")}
        value={instruction.destinationAddress}
      />
      <PaymentInstructionField
        label={t("DashboardPayments.manualInstructions.reference")}
        value={instruction.reference}
      />
      <InstructionNotes>{instruction.instructionsNotes}</InstructionNotes>
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
  const t = useTranslations();
  if (instruction.kind === "crypto_deposit") {
    return <BvnkCryptoDepositInstruction instruction={instruction} action={action} />;
  }

  const isReady = instruction.onboardingStatus === "ready";
  const needsVerification = instruction.onboardingStatus === "verification_required";
  const bank = instruction.bankAccount;
  const verificationUrl = instruction.verificationUrl;

  return (
    <div className="space-y-4">
      <InstructionHeader action={isReady ? action : undefined}>
        <InstructionBadge>
          {t("DashboardPayments.manualInstructions.virtualAccount", {
            currency: instruction.fiatCurrency,
          })}
        </InstructionBadge>
        <InstructionBadge>{instruction.network}</InstructionBadge>
      </InstructionHeader>

      {needsVerification ? (
        <div className="flex items-start gap-3">
          <InstructionIconTile tone="primary">
            <ShieldCheckIcon className="size-5" />
          </InstructionIconTile>
          {/* react-doctor-disable-next-line duplicate-jsx-subtree -- redesign sibling of main's manual-instructions-quote.tsx; goes away when the old design is removed */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardPayments.manualInstructions.identityVerificationRequired")}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-tertiary">
                  {instruction.instructionsNotes}
                </p>
              </div>
              {verificationUrl ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="shrink-0"
                  onClick={() => openExternalRampUrl(verificationUrl)}
                >
                  {t("DashboardPayments.manualInstructions.completeVerification")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {!isReady && !needsVerification ? (
        <div className="flex items-start gap-3">
          <InstructionIconTile tone="secondary">
            <Clock3 className="size-5" />
          </InstructionIconTile>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-primary">
              {t("DashboardPayments.manualInstructions.verificationInReview")}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-tertiary">
              {instruction.instructionsNotes}
            </p>
            <p className="mt-3 flex items-center gap-2 text-xs font-medium text-secondary">
              <Loader2 className="size-3.5 animate-spin" />
              {t("DashboardPayments.manualInstructions.checkingVerificationStatus")}
            </p>
          </div>
        </div>
      ) : null}

      {isReady ? (
        <>
          <PaymentInstructionField
            label={t("DashboardPayments.manualInstructions.paymentReferenceRequired")}
            value={instruction.paymentReference}
            className="lg:col-span-2"
          />
          <div className="grid gap-3 lg:grid-cols-2">
            <PaymentInstructionField
              label={t("DashboardPayments.manualInstructions.remittancePrefix")}
              value={instruction.remittanceInformationPrefix}
            />
            <PaymentInstructionField
              label={t("DashboardPayments.manualInstructions.routingNumber")}
              value={bank?.routingNumber}
            />
            <PaymentInstructionField
              label={t("DashboardPayments.manualInstructions.accountNumber")}
              value={bank?.accountNumber}
            />
            <PaymentInstructionField
              label={t("DashboardPayments.manualInstructions.bankCode")}
              value={bank?.code}
            />
            <PaymentInstructionField
              label={t("DashboardPayments.manualInstructions.bankName")}
              value={bank?.bankName}
            />
          </div>
          <InstructionNotes>{instruction.instructionsNotes}</InstructionNotes>
        </>
      ) : null}
    </div>
  );
}

export function ManualInstructionsQuote({
  amount,
  quote,
  fiatCurrency,
  instructions,
  action,
  description,
}: {
  amount: string;
  quote: ManualQuote;
  fiatCurrency: string;
  instructions: PaymentRampInstruction[];
  /** Button rendered in the instruction header (for example, an on-ramp simulation action). */
  action?: InstructionAction;
  /** Overrides the default fiat-deposit copy (e.g. for crypto-funded off-ramp quotes). */
  description?: string;
}) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const locale = useLocale();
  const instructionList = instructions.map((instruction) => (
    <BvnkInstruction
      key={
        instruction.kind === "crypto_deposit"
          ? instruction.destinationAddress
          : instruction.beneficiaryAddress
      }
      instruction={instruction}
      action={action}
    />
  ));

  if (refresh) {
    // The figure to send first, then the account details; the review already showed the quote.
    return (
      <div className="flex flex-col gap-6">
        {amount ? (
          <div className="space-y-1">
            <p className="text-body text-secondary">
              {t("DashboardPayments.manualInstructions.sendExactly")}
            </p>
            <p className="text-amount font-medium text-primary tabular-nums">
              {formatDecimalAmount(amount, locale)} {fiatCurrency.toUpperCase()}
            </p>
            <p className="text-body text-secondary">
              {description ??
                t("DashboardPayments.manualInstructions.throughProvider", {
                  provider: getRampProviderLabel(quote.provider),
                })}
            </p>
          </div>
        ) : null}
        <div>{instructionList}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <InstructionIconTile tone="primary">
          <LandmarkIcon className="size-5" />
        </InstructionIconTile>
        <div>
          <p className="text-sm font-medium text-primary">
            {t("DashboardPayments.manualInstructions.manualFundingInstructions")}
          </p>
          <p className="mt-2 text-sm text-tertiary">
            {description ??
              t("DashboardPayments.manualInstructions.defaultDescription", {
                amount: amount
                  ? `$${amount}`
                  : t("DashboardPayments.manualInstructions.quotedAmount"),
              })}
          </p>
        </div>
      </div>

      <div className="mt-6">{instructionList}</div>
    </div>
  );
}
