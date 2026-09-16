"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  isZeroQuote,
  MAX_SLIPPAGE_TOLERANCE_BPS,
  type VaultQuoteState,
} from "./earn-vault-slippage";

export interface VaultSlippageSectionProps {
  /** Unique per surface so two modals can never share an input id. */
  idPrefix: string;
  toleranceBps: number | null;
  input: string;
  open: boolean;
  invalid: boolean;
  submitting: boolean;
  /** Direction-specific helper sentence shown under a valid input. */
  help: string;
  onToggle: () => void;
  onChange: (value: string) => void;
}

/** The disclosure hiding the tolerance until someone asks to configure it. */
export function VaultSlippageSection({
  idPrefix,
  toleranceBps,
  input,
  open,
  invalid,
  submitting,
  help,
  onToggle,
  onChange,
}: VaultSlippageSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  const percent =
    toleranceBps === null
      ? "—"
      : `${(toleranceBps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;

  return (
    <div className="mt-3">
      <button
        aria-controls={`${idPrefix}-slippage-section`}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-primary"
        disabled={submitting}
        onClick={onToggle}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
        {t("DashboardEarn.deposit.vaultSlippageToggle", { percent })}
      </button>
      {open || invalid ? (
        <div
          className="mt-2 space-y-2 rounded-lg border border-border-default p-3"
          id={`${idPrefix}-slippage-section`}
        >
          <Label htmlFor={`${idPrefix}-slippage`}>
            {t("DashboardEarn.deposit.vaultSlippageLabel")}
          </Label>
          <Input
            aria-invalid={invalid ? true : undefined}
            disabled={submitting}
            id={`${idPrefix}-slippage`}
            inputMode="numeric"
            maxLength={4}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
            value={input}
          />
          {invalid ? (
            <p className="text-xs text-error" role="alert">
              {t("DashboardEarn.deposit.vaultSlippageInvalid", {
                max: MAX_SLIPPAGE_TOLERANCE_BPS,
              })}
            </p>
          ) : (
            <p className="text-xs leading-5 text-tertiary">{help}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface VaultQuoteNoticeKeys {
  blocked: MessageKey;
  loading: MessageKey;
  unavailable: MessageKey;
  zero: MessageKey;
}

/**
 * Quote-state notices under the summary — loading, unavailable, blocked, or a
 * zero-output quote — shared by the vault DEPOSIT and WITHDRAWAL modals. The
 * modals name their quote fields and copy through the accessors and keys, so
 * the four-branch structure exists exactly once.
 */
export function VaultQuoteNotices<Preview extends { blockingIssues: { message: string }[] }>({
  decimals,
  keys,
  quantity,
  quote,
}: {
  decimals: (preview: Preview) => number;
  keys: VaultQuoteNoticeKeys;
  quantity: (preview: Preview) => string;
  quote: VaultQuoteState<Preview>;
}) {
  const t = useTranslations();
  if (quote.kind === "loading") {
    return (
      <p className="mt-2 text-xs text-tertiary" role="status">
        {t(keys.loading)}
      </p>
    );
  }
  if (quote.kind === "unavailable") {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t(keys.unavailable)}
      </p>
    );
  }
  const blockingIssue = quote.kind === "quoted" ? quote.preview.blockingIssues[0] : undefined;
  if (blockingIssue) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t(keys.blocked, { message: blockingIssue.message })}
      </p>
    );
  }
  if (quote.kind === "quoted" && isZeroQuote(quantity(quote.preview), decimals(quote.preview))) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t(keys.zero)}
      </p>
    );
  }
  return null;
}
