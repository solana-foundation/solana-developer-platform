"use client";

/**
 * The create form's inputs.
 *
 * Kept apart from the form itself so each one can be looked at, and changed,
 * without scrolling past the other seven.
 */

import type { ReactNode } from "react";
import { TokenMark } from "@/components/token-mark";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { fromBaseUnits, toBaseUnits } from "./dvp-amount";
import type { DvpCreateOption } from "./dvp-create.data";
import { CUSTOM } from "./use-dvp-create-form";

/** Mirrors MAX_REF_STRING_BYTES in `services/dvp/validate.ts`. */
const MAX_REF_BYTES = 64;

export function Field({
  children,
  hint,
  htmlFor,
  label,
  labelTrailing,
  warning,
  tone = "muted",
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  label: string;
  /**
   * Sits opposite the label on the same line — a balance, a "Max". Outside the
   * `<Label>` so a click lands on the control it is, not on the input.
   */
  labelTrailing?: ReactNode;
  /**
   * A caution that sits BESIDE the hint rather than replacing it. The hint
   * usually carries something worth keeping on screen — the base units an
   * amount resolves to — and a warning that swallowed it would trade one piece
   * of information for another.
   */
  warning?: ReactNode;
  /** `danger` for a hint that is a correction rather than an explanation. */
  tone?: "muted" | "danger";
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {labelTrailing}
      </div>
      {children}
      {hint ? (
        <p
          className={cn(
            "text-xs leading-relaxed",
            tone === "danger" ? "text-error" : "text-tertiary"
          )}
        >
          {hint}
        </p>
      ) : null}
      {warning ? <p className="text-error text-xs leading-relaxed">{warning}</p> : null}
    </div>
  );
}

/**
 * A mint: pick from a list, or paste one.
 *
 * The asset and cash legs differ only in where their list comes from, so they
 * share this rather than each keeping its own copy of the select-plus-paste
 * pairing and drifting apart.
 */
export function MintField({
  choice,
  custom,
  emptyHint,
  hint,
  id,
  label,
  onChoiceChange,
  onCustomChange,
  options,
  placeholder,
}: {
  choice: string;
  custom: string;
  emptyHint?: string;
  hint: ReactNode;
  id: string;
  label: string;
  onChoiceChange: (next: string) => void;
  onCustomChange: (next: string) => void;
  options: DvpCreateOption[];
  placeholder: string;
}) {
  const t = useTranslations();
  const isCustom = choice === CUSTOM || options.length === 0;

  return (
    <Field hint={options.length === 0 && emptyHint ? emptyHint : hint} htmlFor={id} label={label}>
      {options.length > 0 ? (
        <Select
          ariaLabel={label}
          onValueChange={(next) => onChoiceChange(next ?? CUSTOM)}
          value={choice}
        >
          {options.map((option) => (
            <SelectItem key={option.mint} value={option.mint}>
              <span className="flex items-center gap-2">
                <TokenMark mint={option.mint} size="xs" symbol={option.label} />
                {option.decimals == null
                  ? option.label
                  : t("DashboardMarkets.dvp.mintOption", {
                      label: option.label,
                      decimals: String(option.decimals),
                    })}
              </span>
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t("DashboardMarkets.dvp.cashOther")}</SelectItem>
        </Select>
      ) : null}
      {isCustom ? (
        <Input
          className="font-mono text-xs"
          id={id}
          onChange={(event) => onCustomChange(event.target.value)}
          placeholder={placeholder}
          required
          spellCheck={false}
          value={custom}
        />
      ) : null}
    </Field>
  );
}

/**
 * Compares two u64 base-unit strings. Never `Number`: a u64 exceeds 2^53.
 *
 * @returns negative, zero or positive, like any comparator.
 */
function compareBaseUnits(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * One amount field, in whichever unit the mint allows.
 *
 * Where decimals are known it takes the amount as a person would write it and
 * shows the base units it resolves to, so the conversion is visible rather than
 * magic. Where they are not, it says so and takes base units, because guessing
 * a scale would move the wrong quantity.
 */
export function AmountField({
  balance,
  decimals,
  id,
  label,
  onChange,
  symbol,
  value,
}: {
  /**
   * What the spending wallet holds of this mint, in base units. Null when the
   * leg is not SDP's, or the balance is not known.
   *
   * Shown because this field asks someone to commit a quantity, and it used to
   * ask without ever saying how much they had — so committing more than the
   * wallet holds looked fine until funding failed for insufficient funds, well
   * after the trade was on chain and its escrows published.
   */
  balance: { amount: string; decimals: number } | null;
  decimals: number | null;
  id: string;
  label: string;
  onChange: (next: string) => void;
  symbol: string;
  value: string;
}) {
  const t = useTranslations();
  const converted = decimals === null || value.trim() === "" ? null : toBaseUnits(value, decimals);
  const tooPrecise = converted?.ok === false && converted.reason === "too-precise";

  // Compared in BASE UNITS, as strings of equal length, never as numbers: a
  // u64 exceeds 2^53 and a float comparison would call an over-commitment fine.
  const exceedsBalance =
    balance !== null && converted?.ok === true
      ? compareBaseUnits(converted.baseUnits, balance.amount) > 0
      : false;

  return (
    <Field
      hint={
        decimals === null
          ? t("DashboardMarkets.dvp.fieldAmountHintRaw")
          : tooPrecise
            ? t("DashboardMarkets.dvp.amountTooPrecise", { symbol })
            : converted?.ok
              ? t("DashboardMarkets.dvp.baseUnits", { value: converted.baseUnits })
              : t("DashboardMarkets.dvp.fieldAmountHintDecimals", {
                  symbol,
                  decimals: String(decimals),
                })
      }
      htmlFor={id}
      label={label}
      labelTrailing={
        balance ? (
          <span className="flex items-center gap-2">
            <span className="text-tertiary text-xs tabular-nums">
              {t("DashboardMarkets.dvp.balanceAvailable", {
                amount: fromBaseUnits(balance.amount, balance.decimals),
              })}
            </span>
            <button
              className="rounded text-primary text-xs underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => onChange(fromBaseUnits(balance.amount, balance.decimals))}
              type="button"
            >
              {t("DashboardMarkets.dvp.balanceUseMax")}
            </button>
          </span>
        ) : null
      }
      tone={tooPrecise ? "danger" : "muted"}
      warning={exceedsBalance ? t("DashboardMarkets.dvp.amountExceedsBalance") : null}
    >
      <div className="relative">
        {/* inputMode, never type="number": these resolve to u64 base units and a
            number input rounds above 2^53. */}
        <Input
          className={cn("tabular-nums", symbol && "pr-20")}
          id={id}
          inputMode="decimal"
          onChange={(event) => onChange(event.target.value)}
          placeholder={decimals === null ? "1000" : "10"}
          required
          value={value}
        />
        {/* Symbol only. The mark sits on the picker one line above, and a
            monogram fallback beside its own symbol reads as "TBO TBOND". */}
        {symbol ? (
          <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 max-w-[4.5rem] truncate text-tertiary text-xs">
            {symbol}
          </span>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * Which leg you deliver, as two cards rather than a dropdown.
 *
 * It is the one choice on this form that reverses the direction of everything
 * else, and a collapsed dropdown shows the consequence of only the option you
 * already picked. Both are on screen, and each says what it means for you.
 */
export function SideChoice({
  assetSymbol,
  cashSymbol,
  onChange,
  value,
}: {
  assetSymbol: string;
  cashSymbol: string;
  onChange: (next: "a" | "b") => void;
  value: "a" | "b";
}) {
  const t = useTranslations();
  const options = [
    {
      side: "a" as const,
      title: t("DashboardMarkets.dvp.sideAssetTitle"),
      detail: t("DashboardMarkets.dvp.sideAssetDetail", {
        deliver: assetSymbol || t("DashboardMarkets.dvp.sideAsset"),
        receive: cashSymbol || t("DashboardMarkets.dvp.sideCash"),
      }),
    },
    {
      side: "b" as const,
      title: t("DashboardMarkets.dvp.sideCashTitle"),
      detail: t("DashboardMarkets.dvp.sideCashDetail", {
        deliver: cashSymbol || t("DashboardMarkets.dvp.sideCash"),
        receive: assetSymbol || t("DashboardMarkets.dvp.sideAsset"),
      }),
    },
  ];

  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 font-medium text-primary text-sm">
        {t("DashboardMarkets.dvp.fieldSide")}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = value === option.side;
          return (
            <label
              className={cn(
                "flex cursor-pointer gap-3 rounded-2xl border p-4 transition-colors",
                "focus-within:ring-2 focus-within:ring-border-strong",
                selected
                  ? "border-primary bg-fill-subtle"
                  : "border-border-default bg-surface-raised hover:bg-fill-subtle"
              )}
              key={option.side}
            >
              <input
                checked={selected}
                className="sr-only"
                name="dvp-side"
                onChange={() => onChange(option.side)}
                type="radio"
                value={option.side}
              />
              {/* A drawn radio, not just a tinted background. Which card is
                  chosen has to survive a glance, and a fill this subtle does
                  not read as "selected" on its own. */}
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-primary" : "border-border-strong"
                )}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-primary text-sm">{option.title}</span>
                <span className="mt-1 block text-secondary text-xs leading-relaxed">
                  {option.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The on-chain reference, counted in BYTES.
 *
 * The program stores `ref_string` zero-padded at a fixed width and the API
 * refuses anything over 64 BYTES (`services/dvp/validate.ts:19`). A plain
 * `maxLength={64}` counts UTF-16 code units, so "café" and an emoji both pass
 * the input and then fail the create — the one place where the limit is
 * discovered is after a round trip. Counting the encoded length is the only
 * measure that agrees with the thing enforcing it.
 */
export function ReferenceField({
  id,
  onChange,
  value,
}: {
  id: string;
  onChange: (next: string) => void;
  value: string;
}) {
  const t = useTranslations();
  const used = new TextEncoder().encode(value).length;
  const over = used - MAX_REF_BYTES;

  return (
    <Field
      hint={
        over > 0
          ? t("DashboardMarkets.dvp.fieldRefTooLong", { over: String(over) })
          : t("DashboardMarkets.dvp.fieldRefHint")
      }
      htmlFor={id}
      label={t("DashboardMarkets.dvp.fieldRef")}
      labelTrailing={
        value ? (
          <span className={cn("text-xs tabular-nums", over > 0 ? "text-error" : "text-tertiary")}>
            {t("DashboardMarkets.dvp.fieldRefCount", {
              used: String(used),
              total: String(MAX_REF_BYTES),
            })}
          </span>
        ) : null
      }
      tone={over > 0 ? "danger" : "muted"}
    >
      <Input
        aria-invalid={over > 0}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("DashboardMarkets.dvp.fieldRefPlaceholder")}
        value={value}
      />
    </Field>
  );
}
