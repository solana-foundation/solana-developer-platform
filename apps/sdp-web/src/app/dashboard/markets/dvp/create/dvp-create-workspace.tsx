"use client";

import type { SolanaCluster } from "@sdp/types";
import type { ReactNode } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpCreateContext } from "./dvp-create.data";
import { AmountField, Field, MintField, ReferenceField, SideChoice } from "./dvp-create-fields";
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

              <SideChoice
                assetSymbol={form.asset.symbol}
                cashSymbol={form.cash.symbol}
                onChange={form.setSdpSide}
                value={form.sdpSide}
              />
            </Section>

            <Section
              description={t("DashboardMarkets.dvp.groupLegsHint")}
              title={t("DashboardMarkets.dvp.groupLegs")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
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

                <div className="grid content-start gap-4 rounded-xl border border-border-subtle p-4">
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
              </div>
            </Section>

            <Section
              description={t("DashboardMarkets.dvp.groupTermsHint")}
              title={t("DashboardMarkets.dvp.groupTerms")}
            >
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
                tone={
                  form.counterpartyLooksWrong || form.counterpartyIsOwnLegWallet
                    ? "danger"
                    : "muted"
                }
              >
                <Input
                  aria-invalid={form.counterpartyLooksWrong || form.counterpartyIsOwnLegWallet}
                  className="font-mono text-xs"
                  id="dvp-counterparty"
                  onChange={(event) => form.setCounterparty(event.target.value)}
                  placeholder={PLACEHOLDER_COUNTERPARTY}
                  required
                  spellCheck={false}
                  value={form.counterparty}
                />
              </Field>

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
