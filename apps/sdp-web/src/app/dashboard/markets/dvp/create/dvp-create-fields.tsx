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
import { toBaseUnits } from "./dvp-amount";
import type { DvpCreateOption } from "./dvp-create.data";
import { CUSTOM } from "./use-dvp-create-form";

export function Field({
  children,
  hint,
  htmlFor,
  label,
  tone = "muted",
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  label: string;
  /** `danger` for a hint that is a correction rather than an explanation. */
  tone?: "muted" | "danger";
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
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
 * One amount field, in whichever unit the mint allows.
 *
 * Where decimals are known it takes the amount as a person would write it and
 * shows the base units it resolves to, so the conversion is visible rather than
 * magic. Where they are not, it says so and takes base units, because guessing
 * a scale would move the wrong quantity.
 */
export function AmountField({
  decimals,
  id,
  label,
  onChange,
  symbol,
  value,
}: {
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
      tone={tooPrecise ? "danger" : "muted"}
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
