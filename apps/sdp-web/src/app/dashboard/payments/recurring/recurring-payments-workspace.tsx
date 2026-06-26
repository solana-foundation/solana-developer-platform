"use client";

import {
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentStatus,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { CalendarClockIcon, CopyIcon, ExternalLinkIcon, RepeatIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";

const STATUS_LABELS = {
  pending_activation: "Pending activation",
  activating: "Activating",
  active: "Active",
  canceling: "Canceling",
  resuming: "Resuming",
  paused: "Paused",
  canceled: "Canceled",
  expired: "Expired",
} as const satisfies Record<PaymentRecurringPaymentStatus, string>;

const STATUS_VARIANTS = {
  pending_activation: "warning",
  activating: "warning",
  active: "success",
  canceling: "warning",
  resuming: "warning",
  paused: "info",
  canceled: "danger",
  expired: "danger",
} as const satisfies Record<PaymentRecurringPaymentStatus, BadgeVariant>;

interface RecurringPaymentWalletView {
  walletId: string;
  label: string | null;
  publicKey: string;
  balances: Array<{ mint: string; token: string }>;
}

interface RecurringPaymentCounterpartyView {
  id: string;
  displayName: string;
}

interface RecurringPaymentsWorkspaceProps {
  initialRecurringPayments: PaymentRecurringPayment[];
  initialTotal: number;
  initialError?: string;
  lookupError?: string;
  wallets: RecurringPaymentWalletView[];
  counterparties: RecurringPaymentCounterpartyView[];
}

interface RecurringPaymentDetailWorkspaceProps {
  recurringPayment: PaymentRecurringPayment;
  wallet: RecurringPaymentWalletView | null;
  counterpartyLabel: string;
  amountLabel: string;
  currencyLabel: string;
}

function RecurringPaymentStatusBadge({ status }: { status: PaymentRecurringPaymentStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

function formatOptionalTimestamp(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "Not set";
}

function formatPeriodHours(periodHours: number): string {
  if (periodHours === 24) {
    return "Every day";
  }
  if (periodHours % 168 === 0) {
    const weeks = periodHours / 168;
    return weeks === 1 ? "Every week" : `Every ${weeks} weeks`;
  }
  if (periodHours % 24 === 0) {
    const days = periodHours / 24;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  return periodHours === 1 ? "Every hour" : `Every ${periodHours} hours`;
}

function resolveTokenLabel(token: string, wallets: RecurringPaymentWalletView[]): string {
  const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(token);
  if (knownToken) {
    return knownToken.symbol;
  }

  for (const wallet of wallets) {
    const balance = wallet.balances.find((entry) => entry.mint === token);
    if (balance?.token) {
      return balance.token;
    }
  }

  return token.length <= 12 ? token : shortenAddress(token);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-text-medium">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-text-extra-high">
        {children}
      </span>
    </div>
  );
}

function DetailLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-medium">
      <span className="[&_svg]:size-4 [&_svg]:text-text-medium">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function CopyableValue({
  value,
  label,
  empty = "Not set",
}: {
  value: string | null;
  label?: string;
  empty?: string;
}) {
  if (!value) {
    return <span className="text-text-low">{empty}</span>;
  }

  return (
    <span className="inline-flex max-w-full items-center justify-end gap-2">
      <span
        className="min-w-0 truncate font-mono text-xs text-text-extra-high"
        title={label ?? value}
      >
        {label ?? value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copy value"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  href,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  href?: string;
}) {
  const content = (
    <>
      {href ? (
        <span
          aria-hidden="true"
          className="absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-text-low opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <ExternalLinkIcon className="h-4 w-4" />
        </span>
      ) : null}
      <DetailLabel icon={icon}>{label}</DetailLabel>
      <p className="truncate text-sm font-semibold text-text-extra-high">{value}</p>
    </>
  );

  const className =
    "group relative min-w-0 rounded-xl border border-border-light bg-white px-4 py-3 transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-medium hover:shadow-sm";

  if (href) {
    return (
      <Link
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${label.toLowerCase()}`}
        className={`${className} block focus:outline-none focus-visible:border-border-medium focus-visible:ring-2 focus-visible:ring-black/50`}
      >
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}

export function RecurringPaymentsWorkspace({
  initialRecurringPayments,
  initialTotal,
  initialError,
  lookupError,
  wallets,
  counterparties,
}: RecurringPaymentsWorkspaceProps) {
  const router = useRouter();

  const walletById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.walletId, wallet])),
    [wallets]
  );
  const counterpartyById = useMemo(
    () => new Map(counterparties.map((counterparty) => [counterparty.id, counterparty])),
    [counterparties]
  );

  const countLabel =
    initialTotal === 1 ? "1 recurring payment" : `${initialTotal} recurring payments`;

  const getWalletLabel = (recurringPayment: PaymentRecurringPayment) => {
    const wallet = walletById.get(recurringPayment.sourceWalletId);
    return (
      wallet?.label || (wallet ? shortenAddress(wallet.publicKey) : recurringPayment.sourceWalletId)
    );
  };
  const getCounterpartyLabel = (recurringPayment: PaymentRecurringPayment) =>
    counterpartyById.get(recurringPayment.counterpartyId)?.displayName ??
    "Counterparty unavailable";
  const getAmountLabel = (recurringPayment: PaymentRecurringPayment) =>
    formatDisplayAmount(
      recurringPayment.amount,
      resolveTokenLabel(recurringPayment.token, wallets)
    );

  return (
    <div className="h-full min-h-0 w-full px-3 pt-6 pb-5 md:px-6 md:pb-6">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader>
          <CardTitle>Recurring payments</CardTitle>
          <CardDescription>{countLabel}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          {initialError ? (
            <div
              role="alert"
              className="border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text"
            >
              <p className="font-medium">Unable to load recurring payments</p>
              <p className="mt-1">{initialError}</p>
            </div>
          ) : initialRecurringPayments.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-medium py-16 text-center">
              <RepeatIcon className="h-10 w-10 text-text-extra-low" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-text-extra-high">
                  No recurring payments yet.
                </p>
                <p className="text-sm text-text-low">
                  Created recurring payment records will appear here.
                </p>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              {lookupError ? (
                <p className="mb-3 text-sm text-status-warning-text">{lookupError}</p>
              ) : null}
              <Table className="w-full [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[34%] md:w-[26%] lg:w-[21%] xl:w-[18%]">
                      Status
                    </TableHead>
                    <TableHead className="w-[26%] md:w-[22%] lg:w-[20%] xl:w-[18%]">
                      Amount
                    </TableHead>
                    <TableHead className="w-[40%] md:w-[34%] lg:w-[31%] xl:w-[24%]">
                      Counterparty
                    </TableHead>
                    <TableHead className="hidden lg:table-cell lg:w-[28%] xl:w-[22%]">
                      Funding wallet
                    </TableHead>
                    <TableHead className="hidden xl:table-cell xl:w-[18%]">Interval</TableHead>
                    <TableHead className="hidden md:table-cell md:w-[18%] xl:hidden 2xl:table-cell 2xl:w-[18%]">
                      Next payment
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {initialRecurringPayments.map((recurringPayment) => (
                    <TableRow
                      key={recurringPayment.id}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        router.push(
                          `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                        )
                      }
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          router.push(
                            `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                          );
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <RecurringPaymentStatusBadge status={recurringPayment.status} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="block truncate">{getAmountLabel(recurringPayment)}</span>
                      </TableCell>
                      <TableCell className="text-sm text-text-medium">
                        <span className="block truncate">
                          {getCounterpartyLabel(recurringPayment)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium lg:table-cell">
                        <span className="block truncate">{getWalletLabel(recurringPayment)}</span>
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium xl:table-cell">
                        {formatPeriodHours(recurringPayment.periodHours)}
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium md:table-cell xl:hidden 2xl:table-cell">
                        {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function RecurringPaymentDetailWorkspace({
  recurringPayment,
  counterpartyLabel,
  amountLabel,
  currencyLabel,
}: RecurringPaymentDetailWorkspaceProps) {
  const scheduleLabel = formatPeriodHours(recurringPayment.periodHours);
  const paymentReferenceLabel = shortenAddress(recurringPayment.id);

  return (
    <div className="h-full min-h-0 w-full overflow-auto px-3 pt-6 pb-5 md:px-6 md:pb-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2 className="text-3xl font-medium tracking-tight text-text-extra-high">
              Recurring payment
            </h2>
            <p className="truncate text-sm text-text-medium">
              {counterpartyLabel} · {amountLabel} · {scheduleLabel}
            </p>
          </div>
          <RecurringPaymentStatusBadge status={recurringPayment.status} />
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SummaryMetric icon={<RepeatIcon />} label="Amount" value={amountLabel} />
          <SummaryMetric
            icon={<CalendarClockIcon />}
            label="Billing interval"
            value={scheduleLabel}
          />
          <SummaryMetric
            icon={<CalendarClockIcon />}
            label="Next payment"
            value={formatOptionalTimestamp(recurringPayment.nextCollectionDueAt)}
          />
          <SummaryMetric
            icon={<UserIcon />}
            label="Counterparty"
            value={counterpartyLabel}
            href={`/dashboard/payments/counterparty/${encodeURIComponent(
              recurringPayment.counterpartyId
            )}`}
          />
        </div>

        <div className="rounded-xl border border-border-light px-4">
          <div className="divide-y divide-border-light">
            <DetailRow label="Status">
              <RecurringPaymentStatusBadge status={recurringPayment.status} />
            </DetailRow>
            <DetailRow label="Starts">
              {formatOptionalTimestamp(recurringPayment.firstCollectionAt)}
            </DetailRow>
            <DetailRow label="Next payment">
              {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt)}
            </DetailRow>
            <DetailRow label="Billing interval">{scheduleLabel}</DetailRow>
            <DetailRow label="Currency">{currencyLabel}</DetailRow>
            <DetailRow label="Payment reference">
              <CopyableValue value={recurringPayment.id} label={paymentReferenceLabel} />
            </DetailRow>
            <DetailRow label="Metadata">
              {recurringPayment.metadataUri ? (
                <a
                  href={recurringPayment.metadataUri}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  Open metadata
                </a>
              ) : (
                <span className="text-text-low">Not set</span>
              )}
            </DetailRow>
            <DetailRow label="Created">{formatTimestamp(recurringPayment.createdAt)}</DetailRow>
            <DetailRow label="Updated">{formatTimestamp(recurringPayment.updatedAt)}</DetailRow>
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-medium text-text-extra-high">Billing setup</h3>
          <div className="divide-y divide-border-light rounded-xl border border-border-light px-4">
            <DetailRow label="Plan reference">
              <CopyableValue value={recurringPayment.planId} />
            </DetailRow>
            <DetailRow label="Setup confirmed">
              {formatOptionalTimestamp(recurringPayment.planCreatedAt)}
            </DetailRow>
            <DetailRow label="Setup transaction">
              <CopyableValue value={recurringPayment.planCreationSignature} />
            </DetailRow>
            <DetailRow label="Subscription reference">
              <CopyableValue value={recurringPayment.subscriptionId} />
            </DetailRow>
            <DetailRow label="Authorization transaction">
              <CopyableValue value={recurringPayment.authorizationSignature} />
            </DetailRow>
          </div>
        </div>
      </div>
    </div>
  );
}
