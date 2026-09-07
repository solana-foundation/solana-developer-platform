"use client";

import type { SolanaCluster } from "@sdp/types";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpCreateContext } from "./dvp-create.data";
import {
  AmountField,
  Field,
  MintField,
  ReferenceField,
  SideChoice,
  TradeKindChoice,
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
const PLACEHOLDER_COUNTERPARTY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
/** A second, visibly different address: two fields sharing one placeholder
 * reads as a value that has already been filled in twice. */
const PLACEHOLDER_PARTY_B = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";

/**
 * The cluster arrives as a prop rather than from `useSolanaCluster` so this
 * form is a pure function of its inputs: it can be rendered, and asserted on,
 * without standing up the whole dashboard workspace context.
 */
/**
 * Whose leg this card is.
 *
 * The two cards are written for one direction — "Asset you are trading", "What
 * the other side pays with" — and they did not change when the direction did.
 * Choosing "You deliver the cash" left the cash card still captioned as the
 * counterparty's, which is the opposite of the truth, and left nothing on
 * either card saying which one you were filling in for yourself. The moving
 * balance was the only signal, and a balance is a hint, not a label.
 */
function LegOwner({ owner }: { owner: "you" | "them" | "partyA" | "partyB" }) {
  const t = useTranslations();
  const key = {
    you: "DashboardMarkets.dvp.legYouDeliver",
    them: "DashboardMarkets.dvp.legTheyDeliver",
    // On an agent trade neither leg is yours, so "you deliver" has no referent
    // and naming a side would claim a leg this organization does not hold.
    partyA: "DashboardMarkets.dvp.legPartyADelivers",
    partyB: "DashboardMarkets.dvp.legPartyBDelivers",
  }[owner] as MessageKey;

  return (
    <p
      className={cn(
        "font-medium text-[11px] uppercase tracking-wide",
        owner === "you" ? "text-primary" : "text-tertiary"
      )}
    >
      {t(key)}
    </p>
  );
}

/**
 * The two legs, in the order that matches the trade.
 *
 * Its own component because the workspace was carrying the whole form's
 * branching in one function. What lives here is one decision — which leg is
 * yours — and the markup that decision reorders.
 *
 * The cards are held as values and ordered, rather than duplicated into two
 * branches: writing the markup twice makes the direction check inside each copy
 * provably constant, which is exactly what the compiler said about the first
 * attempt.
 */
function LegCards({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  const t = useTranslations();
  const agent = form.tradeKind === "agent";

  const assetLegCard = (
    <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
      <LegOwner owner={agent ? "partyA" : form.sdpSide === "a" ? "you" : "them"} />
      <MintField
        choice={form.asset.choice}
        custom={form.asset.custom}
        emptyHint={t("DashboardMarkets.dvp.createEmptyTokens")}
        hint={t(
          form.sdpSide === "a"
            ? "DashboardMarkets.dvp.fieldAssetMintHint"
            : "DashboardMarkets.dvp.fieldAssetMintHintTheirs"
        )}
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

  const cashLegCard = (
    <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
      <LegOwner owner={agent ? "partyB" : form.sdpSide === "b" ? "you" : "them"} />
      <MintField
        choice={form.cash.choice}
        custom={form.cash.custom}
        hint={t(
          form.sdpSide === "b"
            ? "DashboardMarkets.dvp.fieldCashMintHintMine"
            : "DashboardMarkets.dvp.fieldCashMintHint"
        )}
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

  // Your leg first, on a trade where one of them is yours. An agent trade has
  // no "your leg", so it keeps the trade's own A-then-B order.
  const yoursFirst = !agent && form.sdpSide === "b";
  return (
    <>
      {yoursFirst ? cashLegCard : assetLegCard}
      {yoursFirst ? assetLegCard : cashLegCard}
    </>
  );
}

/**
 * Who the trade is between.
 *
 * A principal trade has one counterparty, because the other side is the wallet
 * chosen above. An agent trade has two, and neither of them is this
 * organization — so the field that used to say "the other side" would be
 * lying, and both addresses have to be asked for explicitly.
 */
function TradeParties({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();

  if (form.tradeKind === "principal") {
    const wrong = form.counterpartyLooksWrong || form.counterpartyIsOwnLegWallet;
    return (
      <Field
        hint={
          form.counterpartyIsOwnLegWallet
            ? t("DashboardMarkets.dvp.fieldCounterpartyIsOwnWallet")
            : form.counterpartyLooksWrong
              ? t("DashboardMarkets.dvp.fieldCounterpartyInvalid")
              : t("DashboardMarkets.dvp.fieldCounterpartyHint")
        }
        htmlFor="dvp-counterparty"
        label={t("DashboardMarkets.dvp.fieldCounterparty")}
        tone={wrong ? "danger" : "muted"}
      >
        <Input
          aria-invalid={wrong}
          className="text-xs"
          id="dvp-counterparty"
          onChange={(event) => form.setCounterparty(event.target.value)}
          placeholder={PLACEHOLDER_COUNTERPARTY}
          required
          spellCheck={false}
          value={form.counterparty}
        />
      </Field>
    );
  }

  const rows = [
    {
      id: "dvp-party-a",
      label: t("DashboardMarkets.dvp.fieldPartyA"),
      value: form.partyA,
      onChange: form.setPartyA,
      invalid: form.partyALooksWrong,
      placeholder: PLACEHOLDER_COUNTERPARTY,
    },
    {
      id: "dvp-party-b",
      label: t("DashboardMarkets.dvp.fieldPartyB"),
      value: form.partyB,
      onChange: form.setPartyB,
      invalid: form.partyBLooksWrong,
      placeholder: PLACEHOLDER_PARTY_B,
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((row) => (
          <Field
            hint={
              row.invalid
                ? t("DashboardMarkets.dvp.fieldCounterpartyInvalid")
                : t("DashboardMarkets.dvp.fieldPartyHint")
            }
            htmlFor={row.id}
            key={row.id}
            label={row.label}
            tone={row.invalid ? "danger" : "muted"}
          >
            <Input
              aria-invalid={row.invalid}
              className="text-xs"
              id={row.id}
              onChange={(event) => row.onChange(event.target.value)}
              placeholder={row.placeholder}
              required
              spellCheck={false}
              value={row.value}
            />
          </Field>
        ))}
      </div>

      {form.partiesAreSame ? (
        <Callout variant="danger">{t("DashboardMarkets.dvp.fieldPartiesAreSame")}</Callout>
      ) : null}

      {/* Neither party was in the room when this trade was created, and the
          economic terms are not bound by the trade's address, so each of them
          has to check the stored terms before paying anything. Saying so here
          is cheaper than saying it after somebody funds the wrong trade. */}
      <Callout variant="info">{t("DashboardMarkets.dvp.agentVerifyNotice")}</Callout>
    </div>
  );
}

/**
 * Where each side is paid, as a choice per party rather than a hidden box.
 *
 * Sits with the parties because that is what it is about: whose proceeds, and
 * to which account. Naming it by leg ("asset side is paid to") said which token
 * moved and never whose money it was, and described nothing at all on a trade
 * between two other parties.
 */
function PayoutChoices({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();
  const agent = form.tradeKind === "agent";
  const sdpIsA = !agent && form.sdpSide === "a";

  // Whose side each leg is, said in the words this trade kind uses.
  const labelA = agent
    ? t("DashboardMarkets.dvp.fieldPartyA")
    : sdpIsA
      ? t("DashboardMarkets.dvp.reviewYou")
      : t("DashboardMarkets.dvp.counterpartyLabel");
  const labelB = agent
    ? t("DashboardMarkets.dvp.fieldPartyB")
    : sdpIsA
      ? t("DashboardMarkets.dvp.counterpartyLabel")
      : t("DashboardMarkets.dvp.reviewYou");

  const addressA = agent ? form.partyA.trim() : sdpIsA ? "" : form.counterparty.trim();
  const addressB = agent ? form.partyB.trim() : sdpIsA ? form.counterparty.trim() : "";

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
          party={addressA}
          partyLabel={labelA}
          payout={form.destinations.a}
        />
        <PayoutChoice
          id="dvp-payout-b"
          party={addressB}
          partyLabel={labelB}
          payout={form.destinations.b}
        />
      </div>
    </div>
  );
}

/** Which wallet pays, and whether you are a party at all. */
function RoleStep({
  context,
  form,
  wallet,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
  wallet: { address: string; label: string | null } | null;
}) {
  const t = useTranslations();
  const agent = form.tradeKind === "agent";

  // Without one there is nothing to sign the create or pay the escrow rent, so
  // every later stage is unreachable. An empty picker and a dead Continue said
  // none of that.
  if (context.wallets.length === 0) {
    return (
      <Callout title={t("DashboardMarkets.dvp.noWalletsTitle")} variant="warning">
        <span className="grid gap-3">
          <span>{t("DashboardMarkets.dvp.noWalletsBody")}</span>
          <Link
            className="font-medium text-primary text-sm underline underline-offset-4"
            href="/dashboard/wallets"
          >
            {t("DashboardMarkets.dvp.noWalletsAction")}
          </Link>
        </span>
      </Callout>
    );
  }

  return (
    <div className="grid gap-5">
      <Field
        hint={
          wallet
            ? t(
                agent
                  ? "DashboardMarkets.dvp.fieldWalletHintWithAddressAgent"
                  : "DashboardMarkets.dvp.fieldWalletHintWithAddress",
                { address: shortenAddress(wallet.address) }
              )
            : t(
                agent
                  ? "DashboardMarkets.dvp.fieldWalletHintAgent"
                  : "DashboardMarkets.dvp.fieldWalletHint"
              )
        }
        label={t("DashboardMarkets.dvp.fieldWallet")}
      >
        <Select
          ariaLabel={t("DashboardMarkets.dvp.fieldWallet")}
          onValueChange={(next) => form.setWalletId(next ?? "")}
          value={form.walletId}
        >
          {context.wallets.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.label ?? shortenAddress(entry.address)}
            </SelectItem>
          ))}
        </Select>
      </Field>

      <TradeKindChoice onChange={form.setTradeKind} value={form.tradeKind} />
    </div>
  );
}

/**
 * The two legs, and which of them is yours.
 *
 * The side chooser lives HERE rather than on the role stage. It names the two
 * tokens ("You fund the ATD leg. They fund USDC."), and on the role stage those
 * names came from each leg's default selection - a choice the reader had not
 * been shown yet, so step one asserted a token nobody had picked. Beside the
 * leg cards the same sentence describes what is on screen.
 */
function LegsStep({
  context,
  form,
}: {
  context: DvpCreateContext;
  form: ReturnType<typeof useDvpCreateForm>;
}) {
  return (
    <div className="grid gap-5">
      {form.tradeKind === "agent" ? null : (
        <SideChoice
          assetSymbol={form.asset.symbol}
          cashSymbol={form.cash.symbol}
          onChange={form.setSdpSide}
          value={form.sdpSide}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <LegCards context={context} form={form} />
      </div>
    </div>
  );
}

/** Who the two sides are, and where each of them is paid. */
function PartiesStep({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  return (
    <div className="grid gap-6">
      <TradeParties form={form} />
      <PayoutChoices form={form} />
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
 * The last look before rent is spent and two escrow addresses are published.
 *
 * Every other create flow in the product ends in one. This trade cannot be
 * edited afterwards: changing anything means a new trade at a new address, so
 * the recap is the only place a mistake is still cheap.
 */
function ReviewStep({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();
  const agent = form.tradeKind === "agent";
  const sdpIsA = !agent && form.sdpSide === "a";

  const parties = agent
    ? [
        [t("DashboardMarkets.dvp.fieldPartyA"), form.partyA.trim()],
        [t("DashboardMarkets.dvp.fieldPartyB"), form.partyB.trim()],
      ]
    : [
        [
          t("DashboardMarkets.dvp.reviewYou"),
          sdpIsA ? t("DashboardMarkets.dvp.legA") : t("DashboardMarkets.dvp.legB"),
        ],
        [t("DashboardMarkets.dvp.counterpartyLabel"), form.counterparty.trim()],
      ];

  const rows: [string, string][] = [
    ...(parties as [string, string][]),
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
    </div>
  );
}

/** The wizard's stages, in the order the trade is actually decided. */
function useWizardSteps() {
  const t = useTranslations();
  return [
    { label: t("DashboardMarkets.dvp.stepRole"), title: t("DashboardMarkets.dvp.stepRoleTitle") },
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
 * and a review stage — counterparty, ramps, private channels. This was the one
 * long scroll, which also forced a genuine ordering problem: the leg cards name
 * whose leg each one is, so on a trade between two other parties they were
 * labelling parties the form had not asked for yet. Staging puts WHO before
 * WHAT and gives the irreversible step somewhere to be reviewed, which a trade
 * that spends rent and publishes escrow addresses deserves.
 */
/**
 * Whether each stage has been answered, in stage order.
 *
 * A function rather than inline, because every entry is a cluster of
 * conditions and together they were most of the workspace's control flow —
 * which put "why is Continue disabled" and "what does this screen render" in
 * the same place to read.
 *
 * Each stage answers for itself, so Continue cannot carry an incomplete answer
 * forward and the last stage is not the first place a problem shows.
 */
function stageAnswered(form: DvpCreateForm): boolean[] {
  const legsResolved =
    !form.asset.pendingLookup &&
    !form.cash.pendingLookup &&
    Boolean(form.asset.mint && form.cash.mint) &&
    Boolean(form.asset.baseUnits && form.cash.baseUnits);

  return [
    Boolean(form.walletId),
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
  const wallet = context.wallets.find((entry) => entry.id === form.walletId) ?? null;
  const agent = form.tradeKind === "agent";

  const last = steps.length - 1;
  const canContinue = stageAnswered(form)[step];

  const summary = (
    <DvpCreateSummary
      agent={agent}
      amountA={form.asset.amount}
      amountB={form.cash.amount}
      assetMint={form.asset.token?.mint ?? null}
      assetSymbol={form.asset.symbol}
      cashMint={form.cash.token?.mint ?? null}
      cashSymbol={form.cash.symbol}
      counterparty={form.counterparty}
      ready={form.ready}
      sdpSide={form.sdpSide}
    />
  );

  const body = [
    <RoleStep context={context} form={form} key="role" wallet={wallet} />,
    <PartiesStep form={form} key="parties" />,
    <LegsStep context={context} form={form} key="legs" />,
    <TermsStep form={form} key="terms" />,
    <ReviewStep form={form} key="review" />,
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
      description={t(
        agent
          ? "DashboardMarkets.dvp.createDescriptionAgent"
          : "DashboardMarkets.dvp.createDescription"
      )}
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
