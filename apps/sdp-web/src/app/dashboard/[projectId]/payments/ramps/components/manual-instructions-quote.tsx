"use client";

import type { PaymentRampInstruction } from "@sdp/types";
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
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { cn } from "@/lib/utils";

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
  if (!value) {
    return null;
  }

  return (
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InstructionBadges>
          <InstructionBadge>
            {t("DashboardPayments.manualInstructions.cryptoDeposit", {
              currency: instruction.cryptoCurrency,
            })}
          </InstructionBadge>
          <InstructionBadge>{instruction.network}</InstructionBadge>
        </InstructionBadges>
        {action ? <InstructionActionButton action={action} /> : null}
      </div>
      <PaymentInstructionField
        label={t("DashboardPayments.manualInstructions.depositAddress")}
        value={instruction.destinationAddress}
      />
      <PaymentInstructionField
        label={t("DashboardPayments.manualInstructions.reference")}
        value={instruction.reference}
      />
      <div className="rounded-xl bg-fill-subtle px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-tertiary">
          {t("DashboardPayments.manualInstructions.notes")}
        </p>
        <p className="mt-1 text-sm text-primary">{instruction.instructionsNotes}</p>
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InstructionBadges>
          <InstructionBadge>
            {t("DashboardPayments.manualInstructions.virtualAccount", {
              currency: instruction.fiatCurrency,
            })}
          </InstructionBadge>
          <InstructionBadge>{instruction.network}</InstructionBadge>
        </InstructionBadges>
        {isReady && action ? <InstructionActionButton action={action} /> : null}
      </div>

      {needsVerification ? (
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-primary">
            <ShieldCheckIcon className="size-5" />
          </span>
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
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
            <Clock3 className="size-5" />
          </span>
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
          <div className="rounded-xl bg-fill-subtle px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-tertiary">
              {t("DashboardPayments.manualInstructions.notes")}
            </p>
            <p className="mt-1 text-sm text-primary">{instruction.instructionsNotes}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ManualInstructionsQuote({
  amount,
  instructions,
  action,
  description,
}: {
  amount: string;
  instructions: PaymentRampInstruction[];
  /** Button rendered in the instruction header (for example, an on-ramp simulation action). */
  action?: InstructionAction;
  /** Overrides the default fiat-deposit copy (e.g. for crypto-funded off-ramp quotes). */
  description?: string;
}) {
  const t = useTranslations();
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

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-primary">
          <LandmarkIcon className="size-5" />
        </span>
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
