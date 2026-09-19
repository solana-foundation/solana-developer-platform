"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import { useState } from "react";
import { TokenMark } from "@/components/token-mark";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTranslations } from "@/i18n/provider";
import type { DvpCreateContext } from "./dvp-create.data";
import { AmountField, MintField, PartySlotPicker, PayoutAddressPicker } from "./dvp-create-fields";
import type { DvpCreateForm } from "./use-dvp-create-form";
import { EMPTY_PAYOUT_SLOT } from "./use-dvp-destinations";
import { CUSTOM } from "./use-dvp-leg";
import type { DvpPartySlot } from "./use-dvp-parties";

/** The Token-2022 extension kind the API names when SDP cannot move a mint (`UNSUPPORTED_MINT_EXTENSIONS`). */
const TRANSFER_HOOK_EXTENSION = "TransferHook";
/** What the API calls a mint it could not decode. */
const UNREADABLE_MINT_REASON = "unreadable extension data";

/**
 * Why this mint cannot be traded, in the terms the reader can act on: a hook is
 * named for what it costs, an extension the program refuses is named as it is,
 * and a mint SDP could not read says so rather than naming an extension.
 */
type Translate = ReturnType<typeof useTranslations>;

function refusedMintWarning(blockedBy: string | null, t: Translate): string {
  if (blockedBy === null) {
    return t("DashboardMarkets.dvp.mintRefusedUnnamed");
  }
  if (blockedBy === TRANSFER_HOOK_EXTENSION) {
    return t("DashboardMarkets.dvp.mintRefusedTransferHook");
  }
  if (blockedBy === UNREADABLE_MINT_REASON) {
    return t("DashboardMarkets.dvp.mintRefusedUnreadable");
  }
  return t("DashboardMarkets.dvp.mintRefusedExtension", { extension: blockedBy });
}

/**
 * The warning under a leg's mint field, or null when there is nothing to say.
 *
 * @param leg - The leg's chosen mint state.
 * @param t - Translator.
 * @returns The warning, or null.
 */
function legMintWarning(leg: DvpCreateForm["asset"], t: Translate): string | null {
  if (leg.ineligible) {
    return refusedMintWarning(leg.blockedBy, t);
  }
  return leg.pasted.notFound && leg.choice === CUSTOM
    ? t("DashboardMarkets.dvp.mintNotFound")
    : null;
}

/**
 * One side's fields: the party picker on its own row, then the amount and mint.
 * The parties are symmetric but the legs are not — side "a" delivers the
 * asset, side "b" the cash — so each row is captioned and optioned per side.
 *
 * @param props - The row's wiring.
 * @param props.context - The create context, for the party slot's choices.
 * @param props.form - The create form.
 * @param props.onPartyChange - What happens when this side's party changes.
 * @param props.side - Which party's row this is.
 * @returns The leg's fields.
 */
function LegRow({
  context,
  form,
  onPartyChange,
  side,
}: {
  context: DvpCreateContext;
  form: DvpCreateForm;
  onPartyChange: (next: DvpPartySlot) => void;
  side: "a" | "b";
}) {
  const t = useTranslations();
  const a = side === "a";
  const leg = a ? form.asset : form.cash;
  // Said at the field, before an amount is typed, rather than as a 400 on
  // submit. A transfer hook is named for what it costs; the extensions the
  // program itself refuses are named as they are.
  const mintWarning = legMintWarning(leg, t);
  return (
    <div className="grid gap-4">
      <PartySlotPicker
        counterpartyAccounts={context.counterpartyAccounts}
        // The same-address correction sits under the buyer's slot — the one
        // whose pick usually completes the collision.
        error={!a && form.sameAddress ? t("DashboardMarkets.dvp.fieldPartiesAreSame") : null}
        id={`dvp-party-${side}`}
        label={t(
          a ? "DashboardMarkets.dvp.partySlotLabelA" : "DashboardMarkets.dvp.partySlotLabelB"
        )}
        onChange={(next) => onPartyChange(next)}
        slot={a ? form.partyA : form.partyB}
        wallets={context.wallets}
      />
      {/* items-start, not items-end: the amount grows a conversion line
          below itself, which must not drag the mint field down with it. */}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <AmountField
          decimals={leg.decimals}
          disabled={leg.mint === ""}
          id={`dvp-amount-${side}`}
          label={t(a ? "DashboardMarkets.dvp.fieldAmountA" : "DashboardMarkets.dvp.fieldAmountB")}
          onChange={leg.setAmount}
          symbol={leg.symbol}
          value={leg.amount}
        />
        <MintField
          choice={leg.choice}
          custom={leg.custom}
          id={a ? "dvp-asset-mint" : "dvp-cash-mint"}
          label={t(
            a ? "DashboardMarkets.dvp.fieldAssetMint" : "DashboardMarkets.dvp.fieldCashMint"
          )}
          onChoiceChange={leg.setChoice}
          onCustomChange={leg.setCustom}
          options={a ? form.assetOptions : form.cashOptions}
          warning={mintWarning}
        />
      </div>
    </div>
  );
}

/**
 * One leg of the exchange strip as a pill: the coin, the amount, the symbol.
 * Unpicked and untyped values hold their slot — a dashed circle before a coin
 * is chosen, a skeleton bar before an amount is typed — so the strip never
 * reflows as the form fills.
 *
 * @param props - The leg's display values.
 * @param props.amount - The typed amount, or "" before anything was typed.
 * @param props.mint - The chosen mint, or "" before one is chosen.
 * @param props.symbol - The mint's display symbol, possibly "" while unresolved.
 * @returns The leg pill.
 */
function LegChip({ amount, mint, symbol }: { amount: string; mint: string; symbol: string }) {
  return (
    <span className="flex h-10 w-40 min-w-0 items-center gap-2.5 rounded-full border border-border-default bg-surface-raised px-4">
      {mint === "" ? (
        <span
          aria-hidden
          className="h-5 w-5 shrink-0 rounded-full border border-border-default border-dashed"
        />
      ) : (
        <TokenMark className="shrink-0" mint={mint} size="xs" symbol={symbol} />
      )}
      {amount === "" ? (
        <SkeletonBlock className="h-3.5 flex-1 [animation-duration:3s]" />
      ) : (
        <span className="animate-in fade-in zoom-in-95 truncate font-medium text-primary text-sm tabular-nums">
          {amount}
        </span>
      )}
      {symbol === "" ? null : (
        <span className="animate-in fade-in zoom-in-95 text-secondary text-sm" key={symbol}>
          {symbol}
        </span>
      )}
    </span>
  );
}

/** The trade as an exchange between the two leg rows: seller, asset pill, both-ways arrow, cash pill, buyer. */
function ExchangeStrip({ form }: { form: DvpCreateForm }) {
  const t = useTranslations();
  return (
    <div className="my-4 flex items-center justify-center gap-5">
      <span className="text-tertiary text-xs font-medium uppercase tracking-wide">
        {t("DashboardMarkets.dvp.fieldPartyA")}
      </span>
      <LegChip amount={form.asset.amount} mint={form.asset.mint} symbol={form.asset.symbol} />
      <ArrowLeftRightIcon aria-hidden className="h-4 w-4 shrink-0 text-tertiary" />
      <LegChip amount={form.cash.amount} mint={form.cash.mint} symbol={form.cash.symbol} />
      <span className="text-tertiary text-xs font-medium uppercase tracking-wide">
        {t("DashboardMarkets.dvp.fieldPartyB")}
      </span>
    </div>
  );
}

/**
 * Where each side is paid, shown only when the default is toggled off.
 *
 * Stacked, not two to a row. Each picker carries a three-option mode control
 * opposite its label, and at half width that control runs into the next
 * column — the label wraps to two lines and the segments overflow the card.
 * The party pickers above are full width for the same reason, so this also
 * keeps the two identical.
 */
function PayoutChoices({ context, form }: { context: DvpCreateContext; form: DvpCreateForm }) {
  const t = useTranslations();
  return (
    <div className="grid gap-4">
      <PayoutAddressPicker
        counterpartyAccounts={context.counterpartyAccounts}
        id="dvp-payout-a"
        label={t("DashboardMarkets.dvp.payoutAddressA")}
        payout={form.destinations.a}
        wallets={context.wallets}
      />
      <PayoutAddressPicker
        counterpartyAccounts={context.counterpartyAccounts}
        id="dvp-payout-b"
        label={t("DashboardMarkets.dvp.payoutAddressB")}
        payout={form.destinations.b}
        wallets={context.wallets}
      />
    </div>
  );
}

/** The one configuring step: each side names its party and its leg, then where each is paid. */
export function PartiesStep({ context, form }: { context: DvpCreateContext; form: DvpCreateForm }) {
  const t = useTranslations();
  // UI state, not form state: turning the toggle off only REVEALS the payout
  // pickers; the modes change when somebody picks. Turning it back on resets
  // both sides to the default so a hidden redirect can never ride along.
  const [customPayouts, setCustomPayouts] = useState(
    () => form.destinations.a.mode === "elsewhere" || form.destinations.b.mode === "elsewhere"
  );

  const changeParty = (side: "a" | "b", next: DvpPartySlot) => {
    const payout = side === "a" ? form.destinations.a : form.destinations.b;
    // Read before the change lands: for the rest of this handler `form.resolved`
    // still describes the party being replaced.
    const previousPartyAddress = form.resolved[side].address;
    form.setParty(side, next);
    if (!customPayouts) {
      return;
    }
    // Only the DEFAULT follows its party. A payout still sitting on the party's
    // own address is the value this form seeded, so it must not outlive the
    // party that seeded it; clearing it to "" blocks submit, which is the safe
    // direction. A payout pointed somewhere else was chosen deliberately, and
    // rewriting that would send the proceeds to an address the form has stopped
    // showing — the redirect is not stale, it is the point.
    if (payout.address !== "" && payout.address !== previousPartyAddress) {
      return;
    }
    payout.setSlot(next);
  };

  return (
    <div className="grid gap-6">
      <LegRow
        context={context}
        form={form}
        onPartyChange={(next) => changeParty("b", next)}
        side="b"
      />
      <ExchangeStrip form={form} />
      <LegRow
        context={context}
        form={form}
        onPartyChange={(next) => changeParty("a", next)}
        side="a"
      />

      <div className="grid gap-4 rounded-xl border border-border-default bg-surface-raised p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium text-primary text-sm">
              {t("DashboardMarkets.dvp.payoutDefaultToggle")}
            </p>
            <p className="mt-1 text-tertiary text-xs leading-relaxed">
              {t("DashboardMarkets.dvp.payoutDefaultToggleHint")}
            </p>
          </div>
          <ToggleSwitch
            aria-label={t("DashboardMarkets.dvp.payoutDefaultToggle")}
            checked={!customPayouts}
            onChange={(next) => {
              setCustomPayouts(!next);
              form.destinations.a.setMode(next ? "party" : "elsewhere");
              form.destinations.b.setMode(next ? "party" : "elsewhere");
              if (next) {
                // Toggling back on restores the original state: no chosen
                // destination survives in form state to ride along later.
                form.destinations.a.setSlot(EMPTY_PAYOUT_SLOT);
                form.destinations.b.setSlot(EMPTY_PAYOUT_SLOT);
              } else {
                // Revealing the pickers seeds each side with the party it
                // already names, so the default is visible and edited from,
                // never a blank to re-derive. Seeding the SLOT, not a bare
                // address, also puts the picker on the mode that names it.
                form.destinations.a.setSlot(form.partyA);
                form.destinations.b.setSlot(form.partyB);
              }
            }}
          />
        </div>
        {customPayouts ? <PayoutChoices context={context} form={form} /> : null}
      </div>
    </div>
  );
}
