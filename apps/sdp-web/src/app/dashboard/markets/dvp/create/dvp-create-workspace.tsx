"use client";

import type { SolanaCluster } from "@sdp/types";
import { ArrowDownLeftIcon, ArrowLeftRightIcon, ArrowUpRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DateTimePicker } from "@/components/ui/date-picker";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpCreateContext } from "./dvp-create.data";
import {
  AmountField,
  Field,
  MintField,
  PartySlotPicker,
  PayoutAddressPicker,
  ReferenceField,
} from "./dvp-create-fields";
import { type DvpCreateForm, useDvpCreateForm } from "./use-dvp-create-form";
import type { DvpLeg } from "./use-dvp-leg";
import type { DvpPartyResolved } from "./use-dvp-parties";

/**
 * One side's fields: the party picker and mint as one row, then the amount.
 * The parties are symmetric but the legs are not — side "a" delivers the
 * asset, side "b" the cash — so each row is captioned and optioned per side.
 *
 * @param props - The row's wiring.
 * @param props.context - The create context, for the party slot's choices.
 * @param props.form - The create form.
 * @param props.side - Which party's row this is.
 * @returns The leg's fields.
 */
function LegRow({
  context,
  form,
  side,
}: {
  context: DvpCreateContext;
  form: DvpCreateForm;
  side: "a" | "b";
}) {
  const t = useTranslations();
  const a = side === "a";
  const leg = a ? form.asset : form.cash;
  return (
    <div className="grid gap-4">
      {/* items-start, not items-end: the party picker grows an error line
          below itself, which must not drag the mint field down with it. */}
      <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
        <PartySlotPicker
          counterpartyAccounts={context.counterpartyAccounts}
          // The same-address correction sits under the buyer's slot — the one
          // whose pick usually completes the collision.
          error={!a && form.sameAddress ? t("DashboardMarkets.dvp.fieldPartiesAreSame") : null}
          id={`dvp-party-${side}`}
          label={t(
            a ? "DashboardMarkets.dvp.partySlotLabelA" : "DashboardMarkets.dvp.partySlotLabelB"
          )}
          onChange={(next) => form.setParty(side, next)}
          slot={a ? form.partyA : form.partyB}
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
          options={a ? context.tokens : form.cashOptions}
        />
      </div>
      <AmountField
        decimals={leg.decimals}
        disabled={leg.mint === ""}
        id={`dvp-amount-${side}`}
        label={t(a ? "DashboardMarkets.dvp.fieldAmountA" : "DashboardMarkets.dvp.fieldAmountB")}
        onChange={leg.setAmount}
        symbol={leg.symbol}
        tokenName={leg.name}
        value={leg.amount}
      />
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

/** The trade as an exchange between the two leg rows: asset pill, both-ways arrow, cash pill, divider lines out to both edges. */
function ExchangeStrip({ form }: { form: DvpCreateForm }) {
  return (
    <div className="my-4 flex items-center gap-5">
      <div className="flex-1 border-border-default border-t" />
      <LegChip amount={form.asset.amount} mint={form.asset.mint} symbol={form.asset.symbol} />
      <ArrowLeftRightIcon aria-hidden className="h-4 w-4 shrink-0 text-tertiary" />
      <LegChip amount={form.cash.amount} mint={form.cash.mint} symbol={form.cash.symbol} />
      <div className="flex-1 border-border-default border-t" />
    </div>
  );
}

/** Where each side is paid: two destination pickers on one row, shown only when the default is toggled off. */
function PayoutChoices({ context, form }: { context: DvpCreateContext; form: DvpCreateForm }) {
  const t = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <PayoutAddressPicker
        counterpartyAccounts={context.counterpartyAccounts}
        id="dvp-payout-a"
        label={t("DashboardMarkets.dvp.payoutAddressA")}
        payout={form.destinations.a}
      />
      <PayoutAddressPicker
        counterpartyAccounts={context.counterpartyAccounts}
        id="dvp-payout-b"
        label={t("DashboardMarkets.dvp.payoutAddressB")}
        payout={form.destinations.b}
      />
    </div>
  );
}

/** The one configuring step: each side names its party and its leg, then where each is paid. */
function PartiesStep({ context, form }: { context: DvpCreateContext; form: DvpCreateForm }) {
  const t = useTranslations();
  // UI state, not form state: turning the toggle off only REVEALS the payout
  // pickers; the modes change when somebody picks. Turning it back on resets
  // both sides to the default so a hidden redirect can never ride along.
  const [customPayouts, setCustomPayouts] = useState(
    () => form.destinations.a.mode === "elsewhere" || form.destinations.b.mode === "elsewhere"
  );
  return (
    <div className="grid gap-6">
      <LegRow context={context} form={form} side="a" />
      <ExchangeStrip form={form} />
      <LegRow context={context} form={form} side="b" />

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
                // Toggling back on restores the original state: no custom
                // address survives in form state to ride along later.
                form.destinations.a.setAddress("");
                form.destinations.b.setAddress("");
              } else {
                // Revealing the pickers seeds each side with the party it
                // already names, so the default is visible and edited from,
                // never a blank to re-derive.
                const partyA = form.resolved.a.address;
                const partyB = form.resolved.b.address;
                if (partyA !== null) {
                  form.destinations.a.setAddress(partyA);
                }
                if (partyB !== null) {
                  form.destinations.b.setAddress(partyB);
                }
              }
            }}
          />
        </div>
        {customPayouts ? <PayoutChoices context={context} form={form} /> : null}
      </div>
    </div>
  );
}

/**
 * The last look before rent is spent and two escrow addresses are published.
 *
 * Every other create flow in the product ends in one. This trade cannot be
 * edited afterwards: changing anything means a new trade at a new address, so
 * the recap is the only place a mistake is still cheap.
 */
/** One fact row inside a party card: an optional direction icon and the term's name on the left, its value on the right. */
function ReviewFact({
  children,
  icon,
  label,
}: {
  children: ReactNode;
  icon: ReactNode | null;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex shrink-0 items-center gap-1.5 text-tertiary text-xs">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** A leg as a card value: the token's mark beside the amount and symbol. */
function ReviewLeg({ leg }: { leg: DvpLeg }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <TokenMark className="shrink-0" mint={leg.mint} size="xs" symbol={leg.symbol} />
      <span className="truncate font-medium text-primary text-sm tabular-nums">
        {leg.amount} <span className="text-secondary">{leg.symbol}</span>
      </span>
    </span>
  );
}

/**
 * One side of the trade: who the party is, what it delivers, what it
 * receives, and where its proceeds land. Both sides share one card, divided,
 * so the whole trade reads in a single frame — what a last look before an
 * immutable create is for.
 *
 * @param props - The side's facts.
 * @param props.delivers - The leg this party funds.
 * @param props.paidAt - The address this party's proceeds are delivered to.
 * @param props.receives - The leg this party is owed.
 * @param props.resolved - The party's resolved name and address.
 * @param props.title - The side's role caption (seller or buyer).
 * @returns The party side.
 */
function ReviewPartySide({
  delivers,
  paidAt,
  receives,
  resolved,
  title,
}: {
  delivers: DvpLeg;
  paidAt: string;
  receives: DvpLeg;
  resolved: DvpPartyResolved;
  title: string;
}) {
  const t = useTranslations();
  return (
    <div className="grid content-start gap-3 p-4">
      <div>
        <p className="text-tertiary text-xs">{title}</p>
        <p className="mt-1 font-medium text-primary text-sm">
          {resolved.label ?? shortenAddress(resolved.address ?? "")}
        </p>
        {resolved.address === null ? null : (
          <p className="break-all text-tertiary text-xs">{resolved.address}</p>
        )}
      </div>
      <dl className="grid gap-2.5 border-border-default border-t pt-3">
        <ReviewFact
          icon={<ArrowUpRightIcon aria-hidden className="h-3.5 w-3.5" />}
          label={t("DashboardMarkets.dvp.reviewDelivers")}
        >
          <ReviewLeg leg={delivers} />
        </ReviewFact>
        <ReviewFact
          icon={<ArrowDownLeftIcon aria-hidden className="h-3.5 w-3.5" />}
          label={t("DashboardMarkets.dvp.reviewReceives")}
        >
          <ReviewLeg leg={receives} />
        </ReviewFact>
        <ReviewFact icon={null} label={t("DashboardMarkets.dvp.reviewPaidAt")}>
          <span className="text-primary text-sm">{shortenAddress(paidAt)}</span>
        </ReviewFact>
      </dl>
    </div>
  );
}

function ReviewStep({ form }: { form: DvpCreateForm }) {
  const t = useTranslations();

  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field
          hint={t("DashboardMarkets.dvp.fieldExpiryHint")}
          htmlFor="dvp-expiry"
          label={t("DashboardMarkets.dvp.fieldExpiry")}
        >
          {/* An expiry in the past is refused on chain, so it is not offered. */}
          <DateTimePicker
            disablePast
            id="dvp-expiry"
            onChange={form.setExpiry}
            size="xl"
            value={form.expiry}
          />
        </Field>
        <ReferenceField id="dvp-ref" onChange={form.setRefString} value={form.refString} />
      </div>

      <div className="my-4 border-border-default border-t" />

      {form.destinations.anyRedirected ? (
        <Callout variant="warning">{t("DashboardMarkets.dvp.reviewRedirected")}</Callout>
      ) : null}

      <div className="grid divide-y divide-border-default rounded-xl border border-border-default bg-surface-raised sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <ReviewPartySide
          delivers={form.asset}
          paidAt={
            form.destinations.a.resolved === ""
              ? (form.resolved.a.address ?? "")
              : form.destinations.a.resolved
          }
          receives={form.cash}
          resolved={form.resolved.a}
          title={t("DashboardMarkets.dvp.fieldPartyA")}
        />
        <ReviewPartySide
          delivers={form.cash}
          paidAt={
            form.destinations.b.resolved === ""
              ? (form.resolved.b.address ?? "")
              : form.destinations.b.resolved
          }
          receives={form.asset}
          resolved={form.resolved.b}
          title={t("DashboardMarkets.dvp.fieldPartyB")}
        />
      </div>
    </div>
  );
}

/** The wizard's stages, in the order the trade is actually decided. */
function useWizardSteps() {
  const t = useTranslations();
  return [
    {
      label: t("DashboardMarkets.dvp.stepParties"),
      title: t("DashboardMarkets.dvp.stepPartiesTitle"),
    },
    {
      label: t("DashboardMarkets.dvp.stepReview"),
      title: t("DashboardMarkets.dvp.stepReviewTitle"),
    },
  ] as const;
}

/**
 * The create flow, staged.
 *
 * Every other create flow in this product is a WizardFrame with a summary rail
 * and a review stage — counterparty, ramps, private channels. Staging puts WHO
 * before WHAT and gives the irreversible step somewhere to be reviewed, which
 * a trade that spends rent and publishes escrow addresses deserves.
 */
/** Whether each stage has been answered, in stage order. */
function stageAnswered(form: DvpCreateForm): boolean[] {
  const legsResolved =
    !form.asset.pendingLookup &&
    !form.cash.pendingLookup &&
    Boolean(form.asset.mint && form.cash.mint) &&
    Boolean(form.asset.baseUnits && form.cash.baseUnits);

  return [form.partiesReady && legsResolved && !form.destinations.anyLooksWrong, form.ready];
}

/** Back, plus either Continue or the one irreversible button. */
function WizardFooter({
  canContinue,
  form,
  onBack,
  onContinue,
  onLastStep,
}: {
  canContinue: boolean;
  form: DvpCreateForm;
  onBack: () => void;
  onContinue: () => void;
  onLastStep: boolean;
}) {
  const t = useTranslations();

  return (
    <div className="flex items-center justify-between gap-3">
      <Button onClick={onBack} type="button" variant="secondary">
        {t("DashboardMarkets.dvp.wizardBack")}
      </Button>
      {onLastStep ? (
        <Button disabled={form.submitting || !form.ready} onClick={form.submit} type="button">
          {form.submitting
            ? t("DashboardMarkets.dvp.createSubmitting")
            : t("DashboardMarkets.dvp.createAction")}
        </Button>
      ) : (
        <Button disabled={!canContinue} onClick={onContinue} type="button">
          {t("DashboardMarkets.dvp.wizardContinue")}
        </Button>
      )}
    </div>
  );
}

export function DvpCreateWorkspace({
  cluster,
  context,
}: {
  cluster: SolanaCluster;
  context: DvpCreateContext;
}) {
  const t = useTranslations();
  const router = useRouter();
  const form = useDvpCreateForm(cluster, context);
  const steps = useWizardSteps();
  const [step, setStep] = useState(0);

  const last = steps.length - 1;
  const canContinue = stageAnswered(form)[step];

  const body = [
    <PartiesStep context={context} form={form} key="parties" />,
    <ReviewStep form={form} key="review" />,
  ][step];

  const footer = (
    <WizardFooter
      canContinue={canContinue}
      form={form}
      // On the first step there is no earlier step; Back leaves the wizard for
      // the list it was entered from, so the button is never a silent no-op.
      onBack={() =>
        step === 0
          ? router.push(DASHBOARD_MARKETS_SUBNAV_HREFS.dvp)
          : setStep((current) => current - 1)
      }
      onContinue={() => setStep((current) => Math.min(last, current + 1))}
      onLastStep={step === last}
    />
  );

  return (
    <WizardFrame
      currentStep={step}
      description={t("DashboardMarkets.dvp.createDescription")}
      footer={footer}
      progressLabel={t("DashboardMarkets.dvp.wizardProgress", {
        current: String(step + 1),
        total: String(steps.length),
      })}
      steps={steps}
    >
      <div className="grid gap-5">
        {context.error ? <Callout variant="danger">{context.error}</Callout> : null}

        {cluster === "devnet" ? null : (
          <Callout variant="warning">
            {t("DashboardMarkets.dvp.wrongClusterWarning", { cluster })}
          </Callout>
        )}

        {body}

        {form.error ? (
          <Callout live variant="danger">
            {form.error}
          </Callout>
        ) : null}
      </div>
    </WizardFrame>
  );
}
