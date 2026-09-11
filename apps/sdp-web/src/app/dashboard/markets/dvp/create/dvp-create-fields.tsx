"use client";

/**
 * The create form's inputs.
 *
 * Kept apart from the form itself so each one can be looked at, and changed,
 * without scrolling past the other seven.
 */

import { HashIcon, UsersIcon, WalletIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TokenMark } from "@/components/token-mark";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import { toBaseUnits } from "./dvp-amount";
import type {
  DvpCreateCounterpartyAccount,
  DvpCreateOption,
  DvpCreateWallet,
} from "./dvp-create.data";
import { CUSTOM } from "./use-dvp-create-form";
import type { DvpPayout } from "./use-dvp-destinations";
import type { DvpPartySlot } from "./use-dvp-parties";

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
 * A mint, as one searchable combobox: pick from the list, or paste an address.
 *
 * The asset and cash legs differ only in where their list comes from, so they
 * share this rather than each keeping its own copy and drifting apart. A
 * pasted base58 mint surfaces as an option of its own — the token, and
 * nothing else, no "(6 decimals)" suffix: the scale is stated where it can
 * act on the number, in the amount field's conversion line.
 */
export function MintField({
  choice,
  custom,
  id,
  label,
  onChoiceChange,
  onCustomChange,
  options,
}: {
  choice: string;
  custom: string;
  id: string;
  label: string;
  onChoiceChange: (next: string) => void;
  onCustomChange: (next: string) => void;
  options: DvpCreateOption[];
}) {
  const t = useTranslations();
  const isCustom = choice === CUSTOM || options.length === 0;

  const comboOptions: ComboboxOption[] = [
    ...options.map((option) => ({
      value: option.mint,
      label: option.name === null ? option.label : option.name,
      description: option.name === null ? undefined : option.label,
      icon: <TokenMark mint={option.mint} size="xs" symbol={option.label} />,
    })),
    // The pasted mint stays in the list so the trigger can name it; it is
    // otherwise synthesized from the search text below.
    ...(isCustom && custom
      ? [
          {
            value: custom,
            label: shortenAddress(custom),
            description: t("DashboardMarkets.dvp.mintUseAddress"),
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5" id={id}>
      <Combobox
        label={label}
        onChange={(next) => {
          if (options.some((option) => option.mint === next)) {
            onChoiceChange(next);
            return;
          }
          onChoiceChange(CUSTOM);
          onCustomChange(next);
        }}
        options={comboOptions}
        placeholder={t("DashboardMarkets.dvp.mintSlotPlaceholder")}
        queryOption={(query) =>
          BASE58_ADDRESS.test(query)
            ? {
                value: query,
                label: shortenAddress(query),
                description: t("DashboardMarkets.dvp.mintUseAddress"),
              }
            : null
        }
        searchPlaceholder={t("DashboardMarkets.dvp.mintSlotSearchPlaceholder")}
        value={isCustom ? (custom ? custom : null) : choice ? choice : null}
      />
    </div>
  );
}

/**
 * What this field can say about the number you typed. Base-unit conversion is
 * the platform's job and is never surfaced; the only hints left are the
 * unknown-scale case and the one precision refusal typing cannot prevent.
 */
function amountHintKey(
  decimals: number | null,
  tooPrecise: boolean
): { key: MessageKey; values?: Record<string, string> } | null {
  if (decimals === null) {
    return { key: "DashboardMarkets.dvp.fieldAmountHintRaw" };
  }
  // Reachable only when a custom-mint lookup resolves decimals AFTER a finer
  // value was already typed — live typing is blocked at the input.
  if (tooPrecise) {
    return { key: "DashboardMarkets.dvp.amountTooPrecise" };
  }
  return null;
}

/** Whether the text carries more fraction digits than the mint can represent. */
function exceedsScale(value: string, decimals: number): boolean {
  const fraction = value.split(".")[1];
  return fraction !== undefined && fraction.length > decimals;
}

export function AmountField({
  decimals,
  disabled,
  id,
  label,
  onChange,
  symbol,
  tokenName,
  value,
}: {
  decimals: number | null;
  /** No mint chosen yet: the field is inert and carries no hint, because there is nothing to scale against. */
  disabled: boolean;
  id: string;
  label: string;
  onChange: (next: string) => void;
  symbol: string;
  /** The token's human name, shown beside the symbol in the suffix; null when no metadata names it. */
  tokenName: string | null;
  value: string;
}) {
  const t = useTranslations();
  const converted = decimals === null || value.trim() === "" ? null : toBaseUnits(value, decimals);
  const tooPrecise = converted?.ok === false && converted.reason === "too-precise";

  const hint = disabled ? null : amountHintKey(decimals, tooPrecise);

  return (
    <Field
      hint={hint === null ? null : t(hint.key, { symbol, ...hint.values })}
      htmlFor={id}
      label={label}
      tone={tooPrecise ? "danger" : "muted"}
    >
      <div className="relative">
        {/* inputMode, never type="number": these resolve to u64 base units and a
            number input rounds above 2^53. */}
        <Input
          className={cn("tabular-nums", symbol && (tokenName === null ? "pr-20" : "pr-48"))}
          disabled={disabled}
          id={id}
          inputMode="decimal"
          size="xl"
          // Enforced at the keystroke: anything but digits and one dot never
          // lands, and neither does a digit the mint cannot represent — which
          // is what makes the "N decimals" explainer hint unnecessary.
          onChange={(event) => {
            const next = event.target.value;
            if (!/^\d*\.?\d*$/.test(next)) {
              return;
            }
            if (decimals !== null && exceedsScale(next, decimals)) {
              return;
            }
            onChange(next);
          }}
          placeholder={decimals === null ? "1000" : "10"}
          required
          value={value}
        />
        {/* Name and symbol only. The mark sits on the picker one line above,
            and a monogram fallback beside its own symbol reads as "TBO TBOND". */}
        {symbol ? (
          <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 flex max-w-[11rem] items-center gap-1.5 text-tertiary text-xs">
            {tokenName === null ? null : (
              <>
                <span className="truncate">{tokenName}</span>
                <span aria-hidden className="h-3 w-px shrink-0 bg-border-default" />
              </>
            )}
            <span className="shrink-0">{symbol}</span>
          </span>
        ) : null}
      </div>
    </Field>
  );
}

export function PartySlotPicker({
  counterpartyAccounts,
  error,
  id,
  label,
  onChange,
  slot,
  wallets,
}: {
  counterpartyAccounts: DvpCreateCounterpartyAccount[];
  /** A correction shown under the picker, or null when the slot is fine. */
  error: string | null;
  id: string;
  label: string;
  onChange: (next: DvpPartySlot) => void;
  slot: DvpPartySlot;
  wallets: DvpCreateWallet[];
}) {
  const t = useTranslations();
  const formatError =
    slot.mode === "address" && slot.address.length > 0 && !BASE58_ADDRESS.test(slot.address)
      ? t("DashboardMarkets.dvp.partyAddressInvalid")
      : null;
  const pickerError = formatError === null ? error : formatError;
  let control: ReactNode;
  switch (slot.mode) {
    case "wallet":
      control = (
        <Combobox
          hideLabel
          icon={<WalletIcon />}
          label={label}
          onChange={(walletId) => onChange({ mode: "wallet", walletId })}
          options={wallets.map((wallet) => ({
            value: wallet.id,
            label: wallet.label === null ? t("DashboardMarkets.dvp.partySdpWallet") : wallet.label,
            description: shortenAddress(wallet.address),
          }))}
          placeholder={t("DashboardMarkets.dvp.partyWalletPlaceholder")}
          value={slot.walletId === "" ? null : slot.walletId}
        />
      );
      break;
    case "counterparty":
      control = (
        <Combobox
          hideLabel
          icon={<UsersIcon />}
          label={label}
          onChange={(counterpartyAccountId) =>
            onChange({ mode: "counterparty", counterpartyAccountId })
          }
          options={counterpartyAccounts.map((account) => ({
            value: account.counterpartyAccountId,
            label: account.name,
            description: shortenAddress(account.address),
          }))}
          placeholder={t("DashboardMarkets.dvp.partyCounterpartyPlaceholder")}
          value={slot.counterpartyAccountId === "" ? null : slot.counterpartyAccountId}
        />
      );
      break;
    case "address":
      control = (
        <Input
          iconLeft={<HashIcon />}
          id={id}
          onChange={(event) => onChange({ mode: "address", address: event.target.value.trim() })}
          placeholder={t("DashboardMarkets.dvp.partyAddressPlaceholder")}
          size="xl"
          value={slot.address}
        />
      );
      break;
    default: {
      const exhausted: never = slot;
      return exhausted;
    }
  }

  return (
    <Field
      htmlFor={slot.mode === "address" ? id : undefined}
      label={label}
      labelTrailing={
        <SegmentedControl
          ariaLabel={t("DashboardMarkets.dvp.partyModeLabel")}
          className="border-border-subtle"
          optionClassName="whitespace-nowrap"
          options={[
            { value: "wallet", label: t("DashboardMarkets.dvp.partyModeWallet") },
            { value: "counterparty", label: t("DashboardMarkets.dvp.partyModeCounterparty") },
            { value: "address", label: t("DashboardMarkets.dvp.partyModeAddress") },
          ]}
          onChange={(mode) => {
            switch (mode) {
              case "wallet":
                onChange({ mode: "wallet", walletId: "" });
                break;
              case "counterparty":
                onChange({ mode: "counterparty", counterpartyAccountId: "" });
                break;
              case "address":
                onChange({ mode: "address", address: "" });
                break;
            }
          }}
          value={slot.mode}
        />
      }
      warning={pickerError}
    >
      {control}
    </Field>
  );
}

/**
 * One payout destination, as a single searchable combobox.
 *
 * The value is a plain address either way: picking a registered counterparty
 * fills its address, and a pasted base58 address surfaces as an option of its
 * own — an invalid paste never becomes selectable.
 *
 * @param props - The picker's wiring.
 * @param props.counterpartyAccounts - The registered accounts offered as destinations.
 * @param props.id - The DOM id for the picker.
 * @param props.label - The picker's label.
 * @param props.payout - The side's payout state; its address is the value.
 * @returns The payout picker.
 */
export function PayoutAddressPicker({
  counterpartyAccounts,
  id,
  label,
  payout,
}: {
  counterpartyAccounts: DvpCreateCounterpartyAccount[];
  id: string;
  label: string;
  payout: DvpPayout;
}) {
  const t = useTranslations();

  const options: ComboboxOption[] = [
    ...counterpartyAccounts.map((account) => ({
      value: account.address,
      label: account.name,
      description: shortenAddress(account.address),
    })),
    ...(payout.address && !counterpartyAccounts.some((a) => a.address === payout.address)
      ? [
          {
            value: payout.address,
            label: shortenAddress(payout.address),
            description: t("DashboardMarkets.dvp.partyUseAddress"),
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5" id={id}>
      <Combobox
        label={label}
        onChange={payout.setAddress}
        options={options}
        queryOption={(query) =>
          BASE58_ADDRESS.test(query)
            ? {
                value: query,
                label: shortenAddress(query),
                description: t("DashboardMarkets.dvp.partyUseAddress"),
              }
            : null
        }
        searchPlaceholder={t("DashboardMarkets.dvp.partySlotSearchPlaceholder")}
        value={payout.address === "" ? null : payout.address}
      />
    </div>
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
        size="xl"
        value={value}
      />
    </Field>
  );
}
