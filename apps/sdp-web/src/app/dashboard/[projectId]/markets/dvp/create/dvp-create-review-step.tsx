"use client";

import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TokenMark } from "@/components/token-mark";
import { Callout } from "@/components/ui/callout";
import { DateTimePicker } from "@/components/ui/date-picker";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import { AddressWithCopy } from "../dvp-party-cell";
import { Field, ReferenceField } from "./dvp-create-fields";
import type { DvpCreateForm } from "./use-dvp-create-form";
import type { DvpLeg } from "./use-dvp-leg";
import type { DvpPartyResolved } from "./use-dvp-parties";

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
      <dt className="flex shrink-0 items-center gap-1.5 text-secondary text-sm">
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
      <TokenMark className="shrink-0" mint={leg.mint} size="sm" symbol={leg.symbol} />
      <span className="truncate font-medium text-primary text-base tabular-nums">
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
    <div className="grid content-start gap-4 p-5">
      <div>
        <p className="text-tertiary text-sm">{title}</p>
        <p className="mt-1 font-medium text-primary text-base">
          {resolved.label ?? shortenAddress(resolved.address ?? "")}
        </p>
        {resolved.address === null ? null : (
          <p className="text-tertiary text-sm">
            <AddressWithCopy address={resolved.address} />
          </p>
        )}
      </div>
      <dl className="grid gap-3 border-border-default border-t pt-4">
        <ReviewFact
          icon={<ArrowUpRightIcon aria-hidden className="h-4 w-4" />}
          label={t("DashboardMarkets.dvp.reviewDelivers")}
        >
          <ReviewLeg leg={delivers} />
        </ReviewFact>
        <ReviewFact
          icon={<ArrowDownLeftIcon aria-hidden className="h-4 w-4" />}
          label={t("DashboardMarkets.dvp.reviewReceives")}
        >
          <ReviewLeg leg={receives} />
        </ReviewFact>
        <ReviewFact icon={null} label={t("DashboardMarkets.dvp.reviewPaidAt")}>
          <span className="text-base text-primary">{shortenAddress(paidAt)}</span>
        </ReviewFact>
      </dl>
    </div>
  );
}

export function ReviewStep({ form }: { form: DvpCreateForm }) {
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
