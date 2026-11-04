"use client";

import type { HercleFiatFundingInstruction, PaymentRampQuote } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import {
  formatDateTime,
  formatDecimalAmount,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";

type ManualQuote = Extract<PaymentRampQuote, { deliveryMode: "manual_instructions" }>;

async function copyInstruction(
  label: string,
  value: string,
  t: ReturnType<typeof useTranslations>
): Promise<void> {
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

/** One detail of the wire, with a copy control when the sender types it into their bank. */
function InstructionRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string | undefined;
  copyable?: boolean;
}) {
  const t = useTranslations();
  if (value === undefined) {
    return null;
  }
  return (
    <DetailRow label={label} fit="wrap">
      <span className="inline-flex items-center gap-2">
        <span className="break-all">{value}</span>
        {copyable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-tertiary hover:text-primary"
            aria-label={t("DashboardPayments.manualInstructions.copyLabel", { label })}
            onClick={() => void copyInstruction(label, value, t)}
          >
            <CopyIcon className="size-3.5" />
          </Button>
        ) : null}
      </span>
    </DetailRow>
  );
}

/** A bank wire to the business's own account: where it goes, the reference, and who sends it. */
function FiatFundingInstruction({
  instruction,
  expiresAt,
}: {
  instruction: HercleFiatFundingInstruction;
  expiresAt: string | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const bank = instruction.bankAccount;
  const deadline = formatDateTime(expiresAt, locale);
  return (
    <div className="space-y-4">
      <DetailList>
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.iban")}
          value={bank.iban}
          copyable
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.bic")}
          value={bank.bic}
          copyable
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.bankName")}
          value={bank.bankName}
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.accountHolder")}
          value={bank.accountHolder}
          copyable
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.paymentReference")}
          value={bank.paymentReference}
          copyable
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.payFrom")}
          value={bank.payerAccountHolder}
        />
        <InstructionRow
          label={t("DashboardPayments.manualInstructions.fundBy")}
          value={deadline ?? undefined}
        />
      </DetailList>
      <div className="rounded-control bg-fill-subtle px-4 py-3">
        <p className="text-meta text-secondary">
          {t("DashboardPayments.manualInstructions.notes")}
        </p>
        <p className="mt-1 text-body text-primary">{instruction.instructionsNotes}</p>
      </div>
    </div>
  );
}

/**
 * A quote the customer pays by bank transfer: the amount to send first, then the account it goes to.
 * The deposit updates on its own once the provider sees the money.
 * Until then the instructions sit under a waiting callout.
 */
export function ManualInstructionsQuote({
  amount,
  fiatCurrency,
  quote,
}: {
  amount: string;
  fiatCurrency: string;
  quote: ManualQuote;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-8">
      <Callout variant="warning" title={t("DashboardPayments.ramps.status.waitingForFunding")}>
        {t("DashboardPayments.manualInstructions.waitingBody")}
      </Callout>
      {amount ? (
        <div className="space-y-1">
          <p className="text-body text-secondary">
            {t("DashboardPayments.manualInstructions.sendExactly")}
          </p>
          <p className="text-amount font-medium text-primary tabular-nums">
            {formatDecimalAmount(amount, locale)} {fiatCurrency.toUpperCase()}
          </p>
          <p className="text-body text-secondary">
            {t("DashboardPayments.manualInstructions.throughProvider", {
              provider: getRampProviderLabel(quote.provider),
            })}
          </p>
        </div>
      ) : null}
      {quote.paymentInstructions.map((instruction) => (
        <FiatFundingInstruction
          key={instruction.bankAccount.paymentReference}
          instruction={instruction}
          expiresAt={quote.expiresAt}
        />
      ))}
    </div>
  );
}
