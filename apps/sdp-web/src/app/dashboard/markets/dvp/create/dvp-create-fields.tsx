"use client";

/**
 * The create form's inputs.
 *
 * Kept apart from the form itself so each one can be looked at, and changed,
 * without scrolling past the other seven.
 */

import { SegmentedControl } from "@solana/design-system/segmented-control";
import Link from "next/link";
import type { ReactNode } from "react";
import { TokenMark } from "@/components/token-mark";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import { fromBaseUnits, toBaseUnits } from "./dvp-amount";
import type {
  DvpCreateCounterpartyAccount,
  DvpCreateOption,
  DvpCreateWallet,
} from "./dvp-create.data";
import { CUSTOM } from "./use-dvp-create-form";
import type { DvpPartySlot, DvpPartySlotMode } from "./use-dvp-parties";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
              {/* The token, and nothing else. This read "ATD (6 decimals)",
                  which is a fact about how the chain stores the amount and not
                  a reason to pick one token over another — and with both legs
                  usually at six it was the same suffix on every option, so the
                  only varying part was pushed left by a constant. The scale is
                  already stated where it can act on the number: the amount
                  field's own hint says how you write it, and the conversion
                  line under it says what will be sent. It is left over from
                  when this field took base units. */}
              <span className="flex items-center gap-2">
                <TokenMark mint={option.mint} size="xs" symbol={option.label} />
                {option.label}
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
/**
 * What the balance line offers: how much you hold, and a way to spend all of it.
 *
 * Its own component because it was an inline conditional inside a prop, which
 * is where a chunk of `AmountField`'s branching lived.
 */
function BalanceWithMax({
  balance,
  onChange,
}: {
  balance: { amount: string; decimals: number };
  onChange: (next: string) => void;
}) {
  const t = useTranslations();
  const max = fromBaseUnits(balance.amount, balance.decimals);

  return (
    <span className="flex items-center gap-2">
      <span className="text-tertiary text-xs tabular-nums">
        {t("DashboardMarkets.dvp.balanceAvailable", { amount: max })}
      </span>
      <button
        className="rounded text-primary text-xs underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => onChange(max)}
        type="button"
      >
        {t("DashboardMarkets.dvp.balanceUseMax")}
      </button>
    </span>
  );
}

/**
 * Which of the four things this field can say about the number you typed.
 *
 * They are mutually exclusive and were written as a ternary nested four deep,
 * which reads as one expression and is four decisions. Early returns say the
 * same thing in the order the cases actually rank: no scale known, then too
 * precise to send, then the conversion, then how to write it.
 */
function amountHintKey(
  decimals: number | null,
  tooPrecise: boolean,
  converted: ReturnType<typeof toBaseUnits> | null
): { key: MessageKey; values?: Record<string, string> } {
  if (decimals === null) {
    return { key: "DashboardMarkets.dvp.fieldAmountHintRaw" };
  }
  if (tooPrecise) {
    return { key: "DashboardMarkets.dvp.amountTooPrecise" };
  }
  if (converted?.ok) {
    return {
      key: "DashboardMarkets.dvp.baseUnits",
      values: { value: converted.baseUnits },
    };
  }
  return {
    key: "DashboardMarkets.dvp.fieldAmountHintDecimals",
    values: { decimals: String(decimals) },
  };
}

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

  const hint = amountHintKey(decimals, tooPrecise, converted);

  return (
    <Field
      hint={t(hint.key, { symbol, ...hint.values })}
      htmlFor={id}
      label={label}
      labelTrailing={balance ? <BalanceWithMax balance={balance} onChange={onChange} /> : null}
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
 * The three ways to name one party, as a segmented tab bar.
 *
 * The reference type is the only thing that differs between the two slots —
 * picking ANY option fills the slot. The tabs keep all three visible so the
 * choice reads as one control group rather than as three separate fields.
 */
const SLOT_TABS = [
  { mode: "wallet", labelKey: "DashboardMarkets.dvp.partySlotOurWallets" },
  { mode: "counterparty", labelKey: "DashboardMarkets.dvp.partySlotCounterparties" },
  { mode: "address", labelKey: "DashboardMarkets.dvp.partySlotPasteAddress" },
] as const satisfies readonly { mode: DvpPartySlotMode; labelKey: MessageKey }[];

/**
 * One party slot: tabs to choose the reference kind, then the picker for it.
 *
 * Controlled: the slot value comes from the form's zod values and every change
 * replaces the whole slot object, so a slot never holds a value from a
 * reference kind it is not currently showing.
 */
export function PartySlotPicker({
  counterpartyAccounts,
  hint,
  id,
  label,
  onChange,
  slot,
  wallets,
}: {
  counterpartyAccounts: DvpCreateCounterpartyAccount[];
  hint: ReactNode;
  id: string;
  label: string;
  onChange: (next: DvpPartySlot) => void;
  slot: DvpPartySlot;
  wallets: DvpCreateWallet[];
}) {
  const t = useTranslations();

  const addressLooksWrong =
    slot.mode === "address" && slot.address.trim().length > 0 && !BASE58_ADDRESS.test(slot.address);

  return (
    <Field
      hint={addressLooksWrong ? t("DashboardMarkets.dvp.fieldPartyAddressInvalid") : hint}
      htmlFor={id}
      label={label}
    >
      <div className="grid gap-3">
        <SegmentedControl
          aria-label={label}
          items={SLOT_TABS.map((tab) => ({ value: tab.mode, label: t(tab.labelKey) }))}
          onValueChange={(next) => {
            if (next !== slot.mode) {
              // Switching reference kinds starts the slot empty in that kind.
              onChange(
                next === "wallet"
                  ? { mode: "wallet", walletId: "" }
                  : next === "counterparty"
                    ? { mode: "counterparty", counterpartyAccountId: "" }
                    : { mode: "address", address: "" }
              );
            }
          }}
          value={slot.mode}
        />
        {slot.mode === "wallet" ? (
          wallets.length === 0 ? (
            // An empty picker with no explanation reads as a broken control;
            // the notice says why there is nothing to choose and where to fix
            // it, and the paste tab remains available either way.
            <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-tertiary text-xs">
              {t("DashboardMarkets.dvp.noWalletsTitle")}{" "}
              <Link className="text-primary underline underline-offset-2" href="/dashboard/wallets">
                {t("DashboardMarkets.dvp.noWalletsAction")}
              </Link>
            </p>
          ) : (
            <Select
              ariaLabel={label}
              onValueChange={(next) => onChange({ mode: "wallet", walletId: next ?? "" })}
              value={slot.walletId}
            >
              {wallets.map((wallet) => (
                <SelectItem key={wallet.id} value={wallet.id}>
                  {wallet.label ?? shortenAddress(wallet.address)}
                </SelectItem>
              ))}
            </Select>
          )
        ) : null}
        {slot.mode === "counterparty" ? (
          counterpartyAccounts.length === 0 ? (
            <p className="rounded-lg border border-border-subtle bg-surface-sunken px-3 py-2 text-tertiary text-xs">
              {t("DashboardMarkets.dvp.noCounterpartiesHint")}{" "}
              <Link
                className="text-primary underline underline-offset-2"
                href="/dashboard/payments/counterparty"
              >
                {t("DashboardMarkets.dvp.noCounterpartiesAction")}
              </Link>
            </p>
          ) : (
            <Select
              ariaLabel={label}
              onValueChange={(next) =>
                onChange({ mode: "counterparty", counterpartyAccountId: next ?? "" })
              }
              value={slot.counterpartyAccountId}
            >
              {counterpartyAccounts.map((account) => (
                <SelectItem
                  key={account.counterpartyAccountId}
                  value={account.counterpartyAccountId}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate">{account.name}</span>
                    {account.label ? (
                      <span className="truncate text-tertiary text-xs">{account.label}</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </Select>
          )
        ) : null}
        {slot.mode === "address" ? (
          <Input
            aria-invalid={addressLooksWrong}
            className="font-mono text-xs"
            id={id}
            onChange={(event) => onChange({ mode: "address", address: event.target.value })}
            placeholder="7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"
            required
            spellCheck={false}
            value={slot.address}
          />
        ) : null}
      </div>
    </Field>
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
