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
  const expanded = open || invalid;
  const percent =
    toleranceBps === null
      ? "—"
      : `${(toleranceBps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
  const title = t("DashboardEarn.deposit.vaultSlippageTitle");
  const summary = t("DashboardEarn.deposit.vaultSlippageToggle", { percent });

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <button
        aria-controls={`${idPrefix}-slippage-section`}
        aria-expanded={expanded}
        aria-label={`${title}. ${summary}`}
        className="flex min-h-20 w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-fill-subtle focus-visible:outline-2 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={submitting}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold text-primary">{title}</span>
          <span className="text-sm text-secondary">{summary}</span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-secondary transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>
      {expanded ? (
        <div
          className="space-y-2 border-t border-border-subtle px-4 pt-4 pb-4"
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
    </section>
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
