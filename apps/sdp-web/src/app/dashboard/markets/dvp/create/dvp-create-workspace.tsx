"use client";

import type { SolanaCluster } from "@sdp/types";
import type { ReactNode } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
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
import { useDvpCreateForm } from "./use-dvp-create-form";

/**
 * Real devnet addresses, shown only as placeholders so the shape of what a
 * field wants is obvious. Not copy: base58 does not translate.
 */
const PLACEHOLDER_ASSET_MINT = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1";
const PLACEHOLDER_CASH_MINT = "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE";
const PLACEHOLDER_COUNTERPARTY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

/**
 * A titled group of fields.
 *
 * Eight inputs in a column is a wall. Three named groups is a sequence, and the
 * names carry the reason each field is being asked for.
 */
function Section({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="grid gap-4 rounded-2xl border border-border-default p-5">
      <div>
        <h2 className="font-medium text-primary text-sm">{title}</h2>
        <p className="mt-1 text-tertiary text-xs leading-relaxed">{description}</p>
      </div>
      {children}
    </section>
  );
}

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
 * Delivering somewhere other than the address that funded the leg.
 *
 * Collapsed, because the ordinary trade pays each party back at its own
 * address and two more address fields in the open would imply otherwise. An
 * execution desk routinely settles into a different account, and the program
 * has always taken both destinations — SDP was the only part dropping them.
 *
 * Kept in Terms rather than beside the legs on purpose. This is an agreement
 * about where value ends up, not a property of the token being moved, and it is
 * the same class of thing as who the counterparty is and when the trade lapses.
 */
function SettlementDestinations({ form }: { form: ReturnType<typeof useDvpCreateForm> }) {
  const t = useTranslations();
  const rows = [
    {
      id: "dvp-destination-a",
      label: t("DashboardMarkets.dvp.fieldDestinationA"),
      value: form.destinationA,
      onChange: form.setDestinationA,
      invalid: form.destinationALooksWrong,
    },
    {
      id: "dvp-destination-b",
      label: t("DashboardMarkets.dvp.fieldDestinationB"),
      value: form.destinationB,
      onChange: form.setDestinationB,
      invalid: form.destinationBLooksWrong,
    },
  ];

  return (
    <details className="group rounded-xl border border-border-subtle">
      <summary className="cursor-pointer list-none px-4 py-3 text-primary text-sm marker:hidden">
        {t("DashboardMarkets.dvp.groupDestinations")}
        <span className="mt-0.5 block font-normal text-tertiary text-xs">
          {t("DashboardMarkets.dvp.groupDestinationsHint")}
        </span>
      </summary>
      <div className="grid gap-4 border-border-subtle border-t px-4 py-4 sm:grid-cols-2">
        {rows.map((row) => (
          <Field
            hint={
              row.invalid
                ? t("DashboardMarkets.dvp.fieldCounterpartyInvalid")
                : t("DashboardMarkets.dvp.fieldDestinationHint")
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
              placeholder={PLACEHOLDER_COUNTERPARTY}
              spellCheck={false}
              value={row.value}
            />
          </Field>
        ))}
      </div>
    </details>
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
    },
    {
      id: "dvp-party-b",
      label: t("DashboardMarkets.dvp.fieldPartyB"),
      value: form.partyB,
      onChange: form.setPartyB,
      invalid: form.partyBLooksWrong,
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
              placeholder={PLACEHOLDER_COUNTERPARTY}
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

export function DvpCreateWorkspace({
  cluster,
  context,
}: {
  cluster: SolanaCluster;
  context: DvpCreateContext;
}) {
  const t = useTranslations();
  const form = useDvpCreateForm(cluster, context);
  const wallet = context.wallets.find((entry) => entry.id === form.walletId) ?? null;

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <form className="mx-auto w-full max-w-5xl" onSubmit={form.submit}>
        <p className="max-w-2xl text-secondary text-sm leading-relaxed">
          {t("DashboardMarkets.dvp.createDescription")}
        </p>

        {context.error ? (
          <Callout className="mt-5" variant="danger">
            {context.error}
          </Callout>
        ) : null}

        {cluster === "devnet" ? null : (
          <Callout className="mt-5" variant="warning">
            {t("DashboardMarkets.dvp.wrongClusterWarning", { cluster })}
          </Callout>
        )}

        {/* The summary rides alongside on a wide screen and falls under the
            fields on a narrow one, so the trade being described stays in view
            while the numbers that describe it are being typed. */}
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="grid gap-5">
            <Section
              description={t("DashboardMarkets.dvp.groupYourSideHint")}
              title={t("DashboardMarkets.dvp.groupYourSide")}
            >
              <Field
                hint={
                  wallet
                    ? t("DashboardMarkets.dvp.fieldWalletHintWithAddress", {
                        address: shortenAddress(wallet.address),
                      })
                    : t("DashboardMarkets.dvp.fieldWalletHint")
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

              {form.tradeKind === "principal" ? (
                <SideChoice
                  assetSymbol={form.asset.symbol}
                  cashSymbol={form.cash.symbol}
                  onChange={form.setSdpSide}
                  value={form.sdpSide}
                />
              ) : null}
            </Section>

            <Section
              description={t("DashboardMarkets.dvp.groupLegsHint")}
              title={t("DashboardMarkets.dvp.groupLegs")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <LegCards context={context} form={form} />
              </div>
            </Section>

            <Section
              description={t("DashboardMarkets.dvp.groupTermsHint")}
              title={t("DashboardMarkets.dvp.groupTerms")}
            >
              <TradeParties form={form} />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  hint={t("DashboardMarkets.dvp.fieldExpiryHint")}
                  htmlFor="dvp-expiry"
                  label={t("DashboardMarkets.dvp.fieldExpiry")}
                >
                  {/* An expiry in the past is refused on chain, so it is not
                      offered here. */}
                  <DatePicker
                    disablePast
                    id="dvp-expiry"
                    onChange={form.setExpiry}
                    value={form.expiry}
                  />
                </Field>

                <ReferenceField id="dvp-ref" onChange={form.setRefString} value={form.refString} />
              </div>

              <SettlementDestinations form={form} />
            </Section>
          </div>

          <div className="grid gap-4 lg:sticky lg:top-6">
            <DvpCreateSummary
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

            {form.error ? (
              <Callout live variant="danger">
                {form.error}
              </Callout>
            ) : null}

            <Button className="w-full" disabled={form.submitting || !form.ready} type="submit">
              {form.submitting
                ? t("DashboardMarkets.dvp.createSubmitting")
                : t("DashboardMarkets.dvp.createAction")}
            </Button>
          </div>
        </div>
      </form>
    </DashboardWorkspaceOverviewPanel>
  );
}
