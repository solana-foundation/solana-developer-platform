"use client";

import type {
  Counterparty,
  CounterpartyAccount,
  PaymentTransferStatus,
  PaymentTransferSummary,
} from "@sdp/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { StatusText } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  resolveTransferTokenLabel,
  shortenAddress,
  statusMessageKey,
} from "../payments-overview.utils";
import {
  formatDate,
  formatDateTime,
  formatDecimalAmount,
  PAYMENT_STATUS_TONE,
} from "../payments-presentation";
import { AddExternalAccountDialog } from "./add-external-account-dialog";
import { CounterpartyProviderAccounts } from "./counterparty-provider-accounts";
import { TransferDetailModal } from "./counterparty-transfer-detail-modal";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";
import { useCounterpartyProviderAccounts } from "./use-counterparty-provider-accounts";

type Translate = ReturnType<typeof useTranslations>;

interface CounterpartyDetailWorkspaceProps {
  counterparty: Counterparty;
  initialAccounts: CounterpartyAccount[];
  initialTransfers: PaymentTransferSummary[];
  /** How many transfers the contact has in all; more than `initialTransfers` when cut short. */
  transfersTotal?: number;
}

/** The design shows the latest three payments; Transactions has the rest. */
const RECENT_PAYMENTS = 3;

const SETTLED_STATUSES: ReadonlySet<PaymentTransferStatus> = new Set([
  "completed",
  "confirmed",
  "finalized",
]);

function isInbound(transfer: PaymentTransferSummary): boolean {
  return transfer.type === "onramp" || transfer.direction === "inbound";
}

/**
 * What has been paid to the contact, read from the transfers the page loaded: the settled
 * outbound ones, their totals per token, and when the latest went out.
 */
function summarizePayouts(transfers: PaymentTransferSummary[]) {
  const payouts = transfers.filter(
    (transfer) => SETTLED_STATUSES.has(transfer.status) && !isInbound(transfer)
  );
  const totals = new Map<string, number>();
  for (const transfer of payouts) {
    const token = resolveTransferTokenLabel(transfer.token);
    const amount = Number(transfer.amount);
    if (token === undefined || !Number.isFinite(amount)) continue;
    totals.set(token, (totals.get(token) ?? 0) + amount);
  }
  const lastPaidAt = payouts
    .flatMap((transfer) => (transfer.createdAt ? [transfer.createdAt] : []))
    .sort()
    .at(-1);
  return { count: payouts.length, totals, lastPaidAt };
}

const DAY_MS = 86_400_000;

/**
 * When the latest payment went out, in days as the design reads it ("2 days ago", "yesterday");
 * past a month the date says it better.
 */
function lastPaidLabel(iso: string, locale: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / DAY_MS);
  if (Math.abs(days) > 30) return formatDate(iso, locale) ?? iso;
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
}

function paidSoFarLabel(
  summary: ReturnType<typeof summarizePayouts>,
  partial: boolean,
  locale: string,
  t: Translate
): string {
  const payments =
    summary.count === 1
      ? t("DashboardPayments.counterparty.detail.paymentCountOne")
      : t("DashboardPayments.counterparty.detail.paymentCountOther", { count: summary.count });
  if (summary.totals.size > 2 || summary.totals.size === 0) {
    return t("DashboardPayments.counterparty.detail.paidInTokens", {
      payments,
      count: summary.totals.size,
    });
  }
  const amounts = [...summary.totals]
    .map(([token, total]) => `${formatDecimalAmount(String(total), locale)} ${token}`)
    .join(", ");
  return partial
    ? t("DashboardPayments.counterparty.detail.paidSummaryPartial", { amounts, payments })
    : t("DashboardPayments.counterparty.detail.paidSummary", { amounts, payments });
}

/**
 * A titled block of the page: an 18px heading with the block's one action at its right, 16px
 * to the body, 64px from the block above (40 plus the page's 24px rhythm; 16 on a phone). The
 * action keeps the design's 30px control, pulled into the heading's 24px line.
 */
function DetailBlock({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 pt-4 md:pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4 [&>a]:-my-1 [&>a]:[--button-height-md:1.875rem] [&>button]:-my-1 [&>button]:[--button-height-md:1.875rem]">
        <h2 className="text-subheading font-medium text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A label and its value on one 40px rule, as the design's record rows read. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <dt className="shrink-0 text-nav text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-nav font-medium text-primary">{children}</dd>
    </div>
  );
}

function ContactRecord({
  counterparty,
  transfers,
  transfersTotal,
}: {
  counterparty: Counterparty;
  transfers: PaymentTransferSummary[];
  transfersTotal: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const summary = summarizePayouts(transfers);
  const notYet = (
    <span className="font-normal text-tertiary">
      {t("DashboardPayments.counterparty.detail.notPaidYet")}
    </span>
  );
  return (
    <section className="grid gap-x-6 md:grid-cols-2">
      <dl>
        <DetailRow label={t("DashboardPayments.counterparty.type")}>
          {counterparty.entityType === "individual"
            ? t("DashboardPayments.counterparty.individual")
            : t("DashboardPayments.counterparty.business")}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.externalId")}>
          {counterparty.externalId === null ? (
            <span className="font-normal text-tertiary">
              {t("DashboardPayments.counterparty.detail.notSet")}
            </span>
          ) : (
            <span title={counterparty.externalId}>{counterparty.externalId}</span>
          )}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.createdLabel")}>
          {formatDate(counterparty.createdAt, locale)}
        </DetailRow>
      </dl>
      <dl>
        <DetailRow label={t("DashboardPayments.counterparty.detail.status")}>
          {counterparty.status === "active" ? (
            <StatusText tone="positive">
              {t("DashboardPayments.counterparty.detail.statusActive")}
            </StatusText>
          ) : (
            <StatusText tone="neutral">
              {t("DashboardPayments.counterparty.detail.statusArchived")}
            </StatusText>
          )}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.detail.lastPaid")}>
          {summary.lastPaidAt === undefined ? (
            notYet
          ) : (
            <span title={formatDateTime(summary.lastPaidAt, locale) ?? undefined}>
              {lastPaidLabel(summary.lastPaidAt, locale)}
            </span>
          )}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.detail.paidSoFar")}>
          {summary.count === 0
            ? notYet
            : paidSoFarLabel(summary, transfersTotal > transfers.length, locale, t)}
        </DetailRow>
      </dl>
    </section>
  );
}

function AddressesTable({ accounts }: { accounts: CounterpartyAccount[] }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table className="min-w-[560px] table-fixed rounded-none border-0">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[38%]" />
          <col className="w-[24%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{t("DashboardPayments.counterparty.detail.addressName")}</TableHead>
            <TableHead>{t("DashboardPayments.counterparty.detail.address")}</TableHead>
            <TableHead>{t("DashboardPayments.counterparty.detail.added")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell className="truncate text-body text-primary">
                {account.label === null
                  ? t("DashboardPayments.counterparty.detail.unnamedAddress")
                  : account.label}
              </TableCell>
              <TableCell className="text-body text-secondary">
                <span className="inline-flex max-w-full items-center gap-1.5">
                  <span className="truncate tabular-nums" title={account.details.address}>
                    {shortenAddress(account.details.address)}
                  </span>
                  <WalletMetadataCopyButton
                    value={account.details.address}
                    label={t("DashboardPayments.counterparty.address")}
                  />
                </span>
              </TableCell>
              <TableCell className="text-body whitespace-nowrap text-secondary tabular-nums">
                {formatDate(account.createdAt, locale)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PaymentAmount({ transfer }: { transfer: PaymentTransferSummary }) {
  const t = useTranslations();
  const locale = useLocale();
  if (transfer.amount) {
    const token = resolveTransferTokenLabel(transfer.token);
    return (
      <>
        <span className="text-primary">{formatDecimalAmount(transfer.amount, locale)}</span>
        {token === undefined ? null : <span className="text-secondary"> {token}</span>}
      </>
    );
  }
  if (transfer.fiatAmount && transfer.fiatCurrency) {
    return (
      <>
        <span className="text-primary">{formatDecimalAmount(transfer.fiatAmount, locale)}</span>
        <span className="text-secondary"> {transfer.fiatCurrency.toUpperCase()}</span>
      </>
    );
  }
  return (
    <span className="text-tertiary">
      {transfer.status === "awaiting_payment"
        ? t("DashboardPayments.counterparty.detail.notSent")
        : "—"}
    </span>
  );
}

function PaymentsTable({
  transfers,
  onSelect,
}: {
  transfers: PaymentTransferSummary[];
  onSelect: (transfer: PaymentTransferSummary) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table className="min-w-[720px] table-fixed rounded-none border-0">
        <colgroup>
          <col className="w-[18%]" />
          <col className="w-[22%]" />
          <col className="w-[18%]" />
          <col className="w-[20%]" />
          <col className="w-[22%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{t("DashboardPayments.counterparty.detail.status")}</TableHead>
            <TableHead>{t("DashboardPayments.counterparty.detail.transaction")}</TableHead>
            <TableHead className="text-right">
              {t("DashboardPayments.counterparty.detail.amount")}
            </TableHead>
            <TableHead>{t("DashboardPayments.counterparty.detail.wallet")}</TableHead>
            <TableHead>{t("DashboardPayments.counterparty.detail.created")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transfers.map((transfer) => {
            const wallet = isInbound(transfer) ? transfer.destination : transfer.source;
            return (
              <TableRow
                key={transfer.id}
                className="cursor-pointer"
                onClick={() => onSelect(transfer)}
              >
                <TableCell className="text-body whitespace-nowrap">
                  <StatusText tone={PAYMENT_STATUS_TONE[transfer.status]}>
                    {t(statusMessageKey(transfer.status))}
                  </StatusText>
                </TableCell>
                <TableCell className="truncate text-body text-secondary tabular-nums">
                  <button
                    type="button"
                    className="max-w-full truncate text-left focus-visible:underline focus-visible:outline-none"
                    title={transfer.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(transfer);
                    }}
                  >
                    {shortenAddress(transfer.id)}
                  </button>
                </TableCell>
                <TableCell className="text-right text-body whitespace-nowrap tabular-nums">
                  <PaymentAmount transfer={transfer} />
                </TableCell>
                <TableCell className="truncate text-body text-secondary tabular-nums">
                  {wallet ? <span title={wallet}>{shortenAddress(wallet)}</span> : "—"}
                </TableCell>
                <TableCell className="text-body whitespace-nowrap text-secondary">
                  {formatDateTime(transfer.createdAt, locale)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * A contact's page, as the design lays it out: the record (type, external ID, created; status,
 * last paid, paid so far), the saved Solana addresses, the accounts payment providers hold for
 * the contact, the latest payments, what the page does not keep, and Delete. The header titles
 * the page with the contact's name and offers Pay.
 */
export function CounterpartyDetailWorkspace({
  counterparty,
  initialAccounts,
  initialTransfers,
  transfersTotal = initialTransfers.length,
}: CounterpartyDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const providerAccounts = useCounterpartyProviderAccounts(counterparty.id);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState<PaymentTransferSummary | null>(null);
  const recentTransfers = initialTransfers.slice(0, RECENT_PAYMENTS);

  async function confirmDelete() {
    const result = await dashboardFetch(
      `/api/dashboard/counterparty/${encodeURIComponent(counterparty.id)}`,
      { method: "DELETE" }
    );
    if (!result.ok) {
      toast.error(result.error, { position: "bottom-right" });
      return;
    }
    toast.success(t("DashboardPayments.counterparty.deleted", { name: counterparty.displayName }), {
      position: "bottom-right",
    });
    router.push("/dashboard/payments/counterparty");
  }

  const addAddressButton = (
    <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
      {t("DashboardPayments.counterparty.detail.addAddress")}
    </Button>
  );

  return (
    <DashboardWorkspaceOverviewPanel>
      <DashboardPageTitle title={counterparty.displayName} />
      <div className="flex flex-col gap-6" data-counterparty-detail>
        <ContactRecord
          counterparty={counterparty}
          transfers={initialTransfers}
          transfersTotal={transfersTotal}
        />

        <DetailBlock
          title={t("DashboardPayments.counterparty.detail.addresses")}
          aside={accounts.length === 0 ? undefined : addAddressButton}
        >
          {accounts.length === 0 ? (
            <ListEmptyState
              message={t("DashboardPayments.counterparty.detail.noAddresses")}
              description={t("DashboardPayments.counterparty.detail.noAddressesDescription")}
              action={addAddressButton}
            />
          ) : (
            <AddressesTable accounts={accounts} />
          )}
        </DetailBlock>

        <DetailBlock title={t("DashboardPayments.counterparty.detail.providerAccounts")}>
          <CounterpartyProviderAccounts
            accounts={providerAccounts.data}
            error={providerAccounts.error}
          />
        </DetailBlock>

        <DetailBlock
          title={t("DashboardPayments.counterparty.detail.payments")}
          aside={
            recentTransfers.length === 0 ? undefined : (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/dashboard/payments/transactions?counterpartyId=${encodeURIComponent(counterparty.id)}`}
                >
                  {t("DashboardPayments.counterparty.detail.seeAllInTransactions")}
                </Link>
              </Button>
            )
          }
        >
          {recentTransfers.length === 0 ? (
            <ListEmptyState
              message={t("DashboardPayments.counterparty.detail.noPayments")}
              description={t("DashboardPayments.counterparty.detail.noPaymentsDescription")}
            />
          ) : (
            <PaymentsTable transfers={recentTransfers} onSelect={setSelectedTransfer} />
          )}
        </DetailBlock>

        <DetailBlock title={t("DashboardPayments.counterparty.detail.notKeptHere")}>
          <p className="mt-2 max-w-[32em] text-body text-secondary">
            {t("DashboardPayments.counterparty.detail.notKeptHereDescription")}
          </p>
        </DetailBlock>

        <div className="pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-error-border text-error [--button-height-md:1.875rem] hover:bg-error-bg hover:text-error refresh:border-error-border refresh:hover:bg-error-bg"
            onClick={() => setDeleteOpen(true)}
          >
            {t("DashboardPayments.counterparty.detail.delete")}
          </Button>
        </div>
      </div>

      <AddExternalAccountDialog
        isOpen={addOpen}
        counterpartyId={counterparty.id}
        onAdded={(account) => setAccounts((prev) => [account, ...prev])}
        onClose={() => setAddOpen(false)}
      />

      <DeleteCounterpartyDialog
        isOpen={deleteOpen}
        displayName={counterparty.displayName}
        onConfirm={confirmDelete}
        onClose={() => setDeleteOpen(false)}
      />

      {selectedTransfer === null ? null : (
        <TransferDetailModal
          key={selectedTransfer.id}
          transfer={selectedTransfer}
          counterpartyName={counterparty.displayName}
          onClose={() => setSelectedTransfer(null)}
        />
      )}
    </DashboardWorkspaceOverviewPanel>
  );
}
