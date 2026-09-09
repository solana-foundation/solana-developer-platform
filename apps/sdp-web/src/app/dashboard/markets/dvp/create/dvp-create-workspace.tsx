"use client";

import type { SolanaCluster } from "@sdp/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpCreateContext } from "./dvp-create.data";
import {
  AmountField,
  Field,
  MintField,
  PartySlotPicker,
  ReferenceField,
} from "./dvp-create-fields";
import { DvpCreateSummary } from "./dvp-create-summary";
import { PayoutChoice } from "./dvp-payout-choice";
import { type DvpCreateForm, useDvpCreateForm } from "./use-dvp-create-form";

/**
 * Real devnet addresses, shown only as placeholders so the shape of what a
 * field wants is obvious. Not copy: base58 does not translate.
 */
const PLACEHOLDER_ASSET_MINT = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1";
const PLACEHOLDER_CASH_MINT = "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE";

/**
 * Whose leg this card is.
 *
 * The parties are symmetric but the legs are not: party A delivers the asset
 * leg and party B the cash leg, so each card is captioned for its party.
 */
function LegOwner({ owner }: { owner: "partyA" | "partyB" }) {
  const t = useTranslations();
  const key = (
    owner === "partyA"
      ? "DashboardMarkets.dvp.legPartyADelivers"
      : "DashboardMarkets.dvp.legPartyBDelivers"
  ) as MessageKey;

  return <p className="font-medium text-[11px] uppercase tracking-wide text-tertiary">{t(key)}</p>;
}

/** The asset leg's card. Split out so each leg carries its own branching. */
function AssetLegCard({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  const t = useTranslations();
  return (
    <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
      <LegOwner owner="partyA" />
      <MintField
        choice={form.asset.choice}
        custom={form.asset.custom}
        emptyHint={t("DashboardMarkets.dvp.createEmptyTokens")}
        hint={t("DashboardMarkets.dvp.fieldAssetMintHint")}
        id="dvp-asset-mint"
        label={t("DashboardMarkets.dvp.fieldAssetMint")}
        onChoiceChange={form.asset.setChoice}
        onCustomChange={form.asset.setCustom}
        options={context.tokens}
        placeholder={PLACEHOLDER_ASSET_MINT}
      />
      <AmountField
        balance={form.assetBalance}
        decimals={
          form.asset.decimalsKnown
            ? (form.asset.token?.decimals ?? form.asset.pasted.mint?.decimals ?? null)
            : null
        }
        id="dvp-amount-a"
        label={t("DashboardMarkets.dvp.fieldAmountA")}
        onChange={form.asset.setAmount}
        symbol={form.asset.symbol}
        value={form.asset.amount}
      />
    </div>
  );
}

/** The cash leg's card. Its options come from the form, not the token list. */
function CashLegCard({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();
  return (
    <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
      <LegOwner owner="partyB" />
      <MintField
        choice={form.cash.choice}
        custom={form.cash.custom}
        hint={t("DashboardMarkets.dvp.fieldCashMintHint")}
        id="dvp-cash-mint"
        label={t("DashboardMarkets.dvp.fieldCashMint")}
        onChoiceChange={form.cash.setChoice}
        onCustomChange={form.cash.setCustom}
        options={form.cashOptions}
        placeholder={PLACEHOLDER_CASH_MINT}
      />
      <AmountField
        balance={form.cashBalance}
        decimals={
          form.cash.decimalsKnown
            ? (form.cash.token?.decimals ?? form.cash.pasted.mint?.decimals ?? null)
            : null
        }
        id="dvp-amount-b"
        label={t("DashboardMarkets.dvp.fieldAmountB")}
        onChange={form.cash.setAmount}
        symbol={form.cash.symbol}
        value={form.cash.amount}
      />
    </div>
  );
}

/** Both legs, asset first: that is the order the parties were named in. */
function LegCards({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  return (
    <>
      <AssetLegCard context={context} form={form} />
      <CashLegCard form={form} />
    </>
  );
}

/**
 * Where each side is paid, as a choice per party rather than a hidden box.
 *
 * Sits with the parties because that is what it is about: whose proceeds, and
 * to which account. Naming it by leg ("asset side is paid to") said which token
 * moved and never whose money it was.
 */
function PayoutChoices({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();

  const labelA = t("DashboardMarkets.dvp.fieldPartyA");
  const labelB = t("DashboardMarkets.dvp.fieldPartyB");
  const addressA = form.resolved.a.address;
  const addressB = form.resolved.b.address;

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="font-medium text-primary text-sm">
          {t("DashboardMarkets.dvp.groupPayouts")}
        </h3>
        <p className="mt-1 text-tertiary text-xs leading-relaxed">
          {t("DashboardMarkets.dvp.groupPayoutsHint")}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <PayoutChoice
          id="dvp-payout-a"
          party={addressA ?? ""}
          partyLabel={labelA}
          payout={form.destinations.a}
        />
        <PayoutChoice
          id="dvp-payout-b"
          party={addressB ?? ""}
          partyLabel={labelB}
          payout={form.destinations.b}
        />
      </div>
    </div>
  );
}

/** The parties step: two symmetric slots plus where each is paid. */
function PartiesStep({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  const t = useTranslations();
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <PartySlotPicker
          counterpartyAccounts={context.counterpartyAccounts}
          hint={t("DashboardMarkets.dvp.partySlotHintA")}
          id="dvp-party-a"
          label={t("DashboardMarkets.dvp.fieldPartyA")}
          onChange={(next) => form.setParty("a", next)}
          slot={form.partyA}
          wallets={context.wallets}
        />
        <PartySlotPicker
          counterpartyAccounts={context.counterpartyAccounts}
          hint={t("DashboardMarkets.dvp.partySlotHintB")}
          id="dvp-party-b"
          label={t("DashboardMarkets.dvp.fieldPartyB")}
          onChange={(next) => form.setParty("b", next)}
          slot={form.partyB}
          wallets={context.wallets}
        />
      </div>

      {form.sameAddress ? (
        <Callout variant="danger">{t("DashboardMarkets.dvp.fieldPartiesAreSame")}</Callout>
      ) : null}

      <PayoutChoices form={form} />
    </div>
  );
}

/** The two legs, and what each party puts up. */
function LegsStep({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <LegCards context={context} form={form} />
      </div>
    </div>
  );
}

/** How long the other side has, and your own reference for the trade. */
function TermsStep({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        hint={t("DashboardMarkets.dvp.fieldExpiryHint")}
        htmlFor="dvp-expiry"
        label={t("DashboardMarkets.dvp.fieldExpiry")}
      >
        {/* An expiry in the past is refused on chain, so it is not offered. */}
        <DatePicker disablePast id="dvp-expiry" onChange={form.setExpiry} value={form.expiry} />
      </Field>
      <ReferenceField id="dvp-ref" onChange={form.setRefString} value={form.refString} />
    </div>
  );
}

/**
 * The sentinel the picker uses for the settlement-wallet default.
 *
 * The form models the default as the empty string (omitted from the request);
 * a Select cannot display an empty value in its trigger, so the picker maps
 * the sentinel to and from the form's empty string.
 */
const DEFAULT_PAYER = "__settlement_wallet__";

/** Which wallet signs the create and pays the fees and escrow rent. */
function PayerPicker({
  form,
  wallets,
}: {
  form: ReturnType<typeof useDvpCreateForm>;
  wallets: DvpCreateContext["wallets"];
}) {
  const t = useTranslations();
  return (
    <Field
      hint={t("DashboardMarkets.dvp.reviewPayerHint")}
      label={t("DashboardMarkets.dvp.reviewPayer")}
    >
      <Select
        ariaLabel={t("DashboardMarkets.dvp.reviewPayer")}
        onValueChange={(next) => form.setPayerWalletId(next === DEFAULT_PAYER ? "" : (next ?? ""))}
        value={form.payerWalletId === "" ? DEFAULT_PAYER : form.payerWalletId}
      >
        {/* The project settlement wallet: the default, stated, and what is
            sent when nothing is picked. */}
        <SelectItem key="default" value={DEFAULT_PAYER}>
          {t("DashboardMarkets.dvp.payerDefault")}
        </SelectItem>
        {wallets.map((wallet) => (
          <SelectItem key={wallet.id} value={wallet.id}>
            {wallet.label ?? shortenAddress(wallet.address)}
          </SelectItem>
        ))}
      </Select>
    </Field>
  );
}

/**
 * The last look before rent is spent and two escrow addresses are published.
 *
 * Every other create flow in the product ends in one. This trade cannot be
 * edited afterwards: changing anything means a new trade at a new address, so
 * the recap is the only place a mistake is still cheap.
 */
function ReviewStep({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  const t = useTranslations();

  const partyLabel = (side: "a" | "b") =>
    form.resolved[side].label ?? shortenAddress(form.resolved[side].address ?? "");

  const rows: [string, string][] = [
    [t("DashboardMarkets.dvp.fieldPartyA"), partyLabel("a")],
    [t("DashboardMarkets.dvp.fieldPartyB"), partyLabel("b")],
    [
      t("DashboardMarkets.dvp.legA"),
      `${form.asset.amount || "—"} ${form.asset.symbol || ""}`.trim(),
    ],
    [t("DashboardMarkets.dvp.legB"), `${form.cash.amount || "—"} ${form.cash.symbol || ""}`.trim()],
    [t("DashboardMarkets.dvp.fieldExpiry"), form.expiry],
    ...(form.refString.trim()
      ? ([[t("DashboardMarkets.dvp.fieldRef"), form.refString.trim()]] as [string, string][])
      : []),
  ];

  return (
    <div className="grid gap-4">
      <Callout variant="warning">{t("DashboardMarkets.dvp.reviewIntro")}</Callout>

      {form.destinations.anyRedirected ? (
        <Callout variant="warning">{t("DashboardMarkets.dvp.reviewRedirected")}</Callout>
      ) : null}

      <dl className="grid gap-0 overflow-hidden rounded-xl border border-border-subtle">
        {rows.map(([label, value]) => (
          <div
            className="flex items-start justify-between gap-4 border-border-subtle border-b px-4 py-3 last:border-b-0"
            key={label}
          >
            <dt className="text-tertiary text-xs">{label}</dt>
            <dd className="min-w-0 break-all text-right text-primary text-sm">{value || "—"}</dd>
          </div>
        ))}
      </dl>

      <PayerPicker form={form} wallets={context.wallets} />
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
    { label: t("DashboardMarkets.dvp.stepLegs"), title: t("DashboardMarkets.dvp.stepLegsTitle") },
    { label: t("DashboardMarkets.dvp.stepTerms"), title: t("DashboardMarkets.dvp.stepTermsTitle") },
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

  return [
    form.partiesReady && !form.destinations.anyLooksWrong,
    legsResolved,
    Boolean(form.expiry),
    form.ready,
  ];
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
  const form = useDvpCreateForm(cluster, context);
  const steps = useWizardSteps();
  const [step, setStep] = useState(0);

  const last = steps.length - 1;
  const canContinue = stageAnswered(form)[step];

  const summary = (
    <DvpCreateSummary
      amountA={form.asset.amount}
      amountB={form.cash.amount}
      assetMint={form.asset.token?.mint ?? null}
      assetSymbol={form.asset.symbol}
      cashMint={form.cash.token?.mint ?? null}
      cashSymbol={form.cash.symbol}
      partyALabel={form.resolved.a.label ?? shortenAddress(form.resolved.a.address ?? "")}
      partyBLabel={form.resolved.b.label ?? shortenAddress(form.resolved.b.address ?? "")}
      ready={form.ready}
    />
  );

  const body = [
    <PartiesStep context={context} form={form} key="parties" />,
    <LegsStep context={context} form={form} key="legs" />,
    <TermsStep form={form} key="terms" />,
    <ReviewStep context={context} form={form} key="review" />,
  ][step];

  const footer = (
    <WizardFooter
      canContinue={canContinue}
      form={form}
      onBack={() => setStep((current) => Math.max(0, current - 1))}
      onContinue={() => setStep((current) => Math.min(last, current + 1))}
      onLastStep={step === last}
    />
  );

  return (
    <WizardFrame
      aside={<aside className="hidden lg:block">{summary}</aside>}
      currentStep={step}
      description={t("DashboardMarkets.dvp.createDescription")}
      footer={footer}
      // The frame defaults to max-w-3xl and then puts a 440px rail inside
      // it, which leaves the content about 330px wide and crushes the leg
      // cards. The other wizard that uses an aside sets the same width.
      maxWidthClassName="max-w-6xl"
      progressLabel={t("DashboardMarkets.dvp.wizardProgress", {
        current: String(step + 1),
        total: String(steps.length),
      })}
      steps={steps}
      summary={summary}
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
