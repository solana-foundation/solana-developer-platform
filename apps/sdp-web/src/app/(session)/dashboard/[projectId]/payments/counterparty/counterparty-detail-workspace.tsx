"use client";

import { addDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { Counterparty, CounterpartyAccount } from "@sdp/types/counterparties";
import type { PaymentTransferSummary } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { StatusText } from "@sdp/ui/status-text";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import {
  resolveTransferTokenLabel,
  shortenAddress,
  statusMessageKey,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import {
  formatDate,
  formatDateTime,
  formatDecimalAmount,
  isInboundTransfer,
  PAYMENT_STATUS_TONE,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import {
  counterpartyReads,
  paymentsQueryKeys,
  paymentTransferReads,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  transferListResponseSchema,
  transferPageResponseSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-read-schemas";
import { RecordLoadError } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { CounterpartyDetailSkeleton } from "@/app/(session)/dashboard/[projectId]/payments/payments-route-skeletons";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  type DashboardRequestKey,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";
import {
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
  useInvalidateDashboardReads,
} from "@/lib/dashboard-swr";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { AddExternalAccountDialog } from "./add-external-account-dialog";
import { SETTLED_PAYOUT_STATUSES } from "./counterparty-detail.data";
import { CounterpartyProviderAccounts } from "./counterparty-provider-accounts";
import {
  counterpartyAccountsResponseSchema,
  counterpartyResponseSchema,
} from "./counterparty-read-schemas";
import { TransferDetailModal } from "./counterparty-transactions";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";
import { useCounterpartyProviderAccounts } from "./use-counterparty-provider-accounts";

type Translate = ReturnType<typeof useTranslations>;

interface CounterpartyDetailWorkspaceProps {
  counterparty: Counterparty;
  initialAccounts: CounterpartyAccount[];
  /** How many addresses the contact has saved; more than `initialAccounts` when cut short. */
  accountsTotal?: number;
  /** True when the addresses could not be read: none loaded is not none saved. */
  accountsFailed?: boolean;
  /** The latest transfers, for the Payments block. */
  initialTransfers: PaymentTransferSummary[];
  /** True when the transfers could not be read: the history is unknown, not empty. */
  transfersFailed?: boolean;
  /** The contact's settled outbound payouts, newest first, for Last paid and Paid so far. */
  payouts: PaymentTransferSummary[];
  /** How many payouts the contact has in all; more than `payouts` when the read was capped. */
  payoutsTotal?: number;
  /** True when the payouts could not all be read. */
  payoutsFailed?: boolean;
  /** Whether provider-owned fiat accounts are available in this deployment. */
  rampsEnabled: boolean;
}

/** The design shows the latest three payments; Transactions has the rest. */
const RECENT_PAYMENTS = 3;

const SETTLED_STATUSES = new Set(SETTLED_PAYOUT_STATUSES);

function isInbound(transfer: PaymentTransferSummary): boolean {
  return transfer.type === "onramp" || transfer.direction === "inbound";
}

/**
 * What has been paid to the contact, read from the payouts the page loaded: the settled
 * outbound ones (the read asks for only those; this holds to it), their totals per token (added
 * as decimal strings, so no float rounding), and when the latest went out.
 */
function summarizePayouts(transfers: PaymentTransferSummary[]) {
  const payouts = transfers.filter(
    (transfer) => SETTLED_STATUSES.has(transfer.status) && !isInbound(transfer)
  );
  const totals = new Map<string, string>();
  for (const transfer of payouts) {
    const token = resolveTransferTokenLabel(transfer.token);
    const amount = transfer.amount?.trim();
    if (token === undefined || amount === undefined || !isDecimalString(amount)) continue;
    const total = totals.get(token);
    totals.set(token, total === undefined ? amount : addDecimalAmounts(total, amount));
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
function lastPaidLabel(iso: string, locale: string, timeZone: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / DAY_MS);
  if (Math.abs(days) > 30) return formatDate(iso, locale, timeZone) ?? iso;
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
    return partial
      ? t("DashboardPayments.counterparty.detail.paidInTokensPartial", {
          payments,
          count: summary.totals.size,
        })
      : t("DashboardPayments.counterparty.detail.paidInTokens", {
          payments,
          count: summary.totals.size,
        });
  }
  const amounts = [...summary.totals]
    .map(([token, total]) => `${formatDecimalAmount(total, locale)} ${token}`)
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
  // 24px between blocks plus 30 here: the design's 54 from the rows above to the heading.
  return (
    <section className="flex flex-col gap-4 pt-4 md:pt-7.5">
      <div className="flex flex-wrap items-center justify-between gap-4 [&>a]:-my-1 [&>a]:[--button-height-md:1.875rem] [&>button]:-my-1 [&>button]:[--button-height-md:1.875rem]">
        <h2 className="text-subheading font-medium text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ContactRecord({
  counterparty,
  payouts,
  payoutsTotal,
  payoutsFailed,
}: {
  counterparty: Counterparty;
  payouts: PaymentTransferSummary[];
  payoutsTotal: number;
  payoutsFailed: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const summary = summarizePayouts(payouts);
  // Only the latest payouts were read (the cap, or a later page failed): older ones are not in
  // the total.
  const partial = payoutsTotal > payouts.length;
  // With nothing read, a failed read is not "never paid".
  const notPaid = (unpaid: string) => (
    <span className="text-tertiary">
      {payoutsFailed ? t("DashboardPayments.counterparty.detail.paymentsNotLoaded") : unpaid}
    </span>
  );
  return (
    <section className="grid gap-x-6 md:grid-cols-2">
      <DetailList>
        <DetailRow label={t("DashboardPayments.counterparty.type")}>
          {counterparty.entityType === "individual"
            ? t("DashboardPayments.counterparty.individual")
            : t("DashboardPayments.counterparty.business")}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.externalId")}>
          {counterparty.externalId === null ? (
            <span className="text-tertiary">
              {t("DashboardPayments.counterparty.detail.notSet")}
            </span>
          ) : (
            <span title={counterparty.externalId}>{counterparty.externalId}</span>
          )}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.createdLabel")}>
          {formatDate(counterparty.createdAt, locale, timeZone)}
        </DetailRow>
      </DetailList>
      <DetailList>
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
            notPaid(t("DashboardPayments.counterparty.detail.neverPaid"))
          ) : (
            <span title={formatDateTime(summary.lastPaidAt, locale, timeZone) ?? undefined}>
              {lastPaidLabel(summary.lastPaidAt, locale, timeZone)}
            </span>
          )}
        </DetailRow>
        <DetailRow label={t("DashboardPayments.counterparty.detail.paidSoFar")}>
          {summary.count === 0
            ? notPaid(t("DashboardPayments.counterparty.detail.nothingPaidYet"))
            : paidSoFarLabel(summary, partial, locale, t)}
        </DetailRow>
      </DetailList>
    </section>
  );
}

function AddressesTable({ accounts }: { accounts: CounterpartyAccount[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  return (
    <div className="overflow-x-auto -mx-3">
      <Table className="min-w-[35rem] table-fixed rounded-none border-0">
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
                {formatDate(account.createdAt, locale, timeZone)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The saved addresses, or why there are none. A failed read offers a retry rather than say none
 * are saved; a capped one says how many of them it shows.
 */
function SavedAddresses({
  accounts,
  read,
  addAddressButton,
}: {
  accounts: CounterpartyAccount[];
  /** How many saved addresses the page read of how many there are; null when the read failed. */
  read: { count: number; total: number } | null;
  addAddressButton: ReactNode;
}) {
  const t = useTranslations();
  const invalidateReads = useInvalidateDashboardReads();
  if (accounts.length === 0 && read === null) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.counterparty.detail.addressesLoadFailed")}
        description={t("DashboardPayments.counterparty.detail.addressesLoadFailedDescription")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void invalidateReads(counterpartyDetailReads)}
          >
            {t("Shared.SharedComponents.retry")}
          </Button>
        }
      />
    );
  }
  if (accounts.length === 0) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.counterparty.detail.noAddresses")}
        description={t("DashboardPayments.counterparty.detail.noAddressesDescription")}
        action={addAddressButton}
      />
    );
  }
  let notice: string | null = null;
  if (read === null) {
    // The read failed and the user has added one since: the rest are still unread.
    notice = t("DashboardPayments.counterparty.detail.addressesLoadFailed");
  } else if (read.total > read.count) {
    notice = t("DashboardPayments.counterparty.detail.addressesCapped", read);
  }
  return (
    <>
      <AddressesTable accounts={accounts} />
      {notice === null ? null : <p className="text-meta text-tertiary">{notice}</p>}
    </>
  );
}

function PaymentAmount({ transfer }: { transfer: PaymentTransferSummary }) {
  const t = useTranslations();
  const locale = useLocale();
  // A buy and a sale of the same size would otherwise read the same.
  const sign = isInboundTransfer(transfer) ? "+" : "−";
  if (transfer.amount) {
    const token = resolveTransferTokenLabel(transfer.token);
    return (
      <>
        <span className="font-medium text-primary">
          {sign}
          {formatDecimalAmount(transfer.amount, locale)}
        </span>
        {token === undefined ? null : <span className="text-secondary"> {token}</span>}
      </>
    );
  }
  if (transfer.fiatAmount && transfer.fiatCurrency) {
    return (
      <>
        <span className="font-medium text-primary">
          {sign}
          {formatDecimalAmount(transfer.fiatAmount, locale)}
        </span>
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
  const timeZone = useTimeZone();
  return (
    <div className="overflow-x-auto -mx-3">
      <Table className="min-w-[45rem] table-fixed rounded-none border-0">
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
                  {formatDateTime(transfer.createdAt, locale, timeZone)}
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
 * The latest payments, or why there are none: a failed read offers a retry rather than claim
 * the contact was never paid.
 */
function RecentPayments({
  transfers,
  failed,
  onSelect,
}: {
  transfers: PaymentTransferSummary[];
  failed: boolean;
  onSelect: (transfer: PaymentTransferSummary) => void;
}) {
  const t = useTranslations();
  const invalidateReads = useInvalidateDashboardReads();
  if (transfers.length > 0) return <PaymentsTable transfers={transfers} onSelect={onSelect} />;
  if (failed) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.counterparty.detail.paymentsLoadFailed")}
        description={t("DashboardPayments.counterparty.detail.paymentsLoadFailedDescription")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void invalidateReads(counterpartyDetailReads)}
          >
            {t("Shared.SharedComponents.retry")}
          </Button>
        }
      />
    );
  }
  return (
    <ListEmptyState
      message={t("DashboardPayments.counterparty.detail.noPayments")}
      description={t("DashboardPayments.counterparty.detail.noPaymentsDescription")}
    />
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
  accountsTotal = initialAccounts.length,
  accountsFailed = false,
  initialTransfers,
  transfersFailed = false,
  payouts,
  payoutsTotal = payouts.length,
  payoutsFailed = false,
  rampsEnabled,
}: CounterpartyDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const invalidateReads = useInvalidateDashboardReads();
  const providerAccounts = useCounterpartyProviderAccounts(counterparty.id, {
    enabled: rampsEnabled,
  });
  // Addresses added here since the page loaded. The list follows the page's read, so a Retry
  // or other refresh shows what it loaded; an added address the read now holds is shown once.
  const [added, setAdded] = useState<CounterpartyAccount[]>([]);
  const accounts = [
    ...added.filter((account) => !initialAccounts.some((loaded) => loaded.id === account.id)),
    ...initialAccounts,
  ];
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState<PaymentTransferSummary | null>(null);
  const recentTransfers = initialTransfers.slice(0, RECENT_PAYMENTS);
  const canWrite = useCanWrite();

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
    router.push(href("/dashboard/payments/counterparty"));
    // This page's own reads are left alone: refetched while it is still on screen, the deleted
    // contact would answer 404 and flash not-found before the list replaces it.
    const ownReads = readsUnderPath(
      `/api/dashboard/counterparty/${encodeURIComponent(counterparty.id)}`
    );
    void invalidateReads((key) => counterpartyReads(key) && !ownReads(key));
  }

  const addAddressButton = canWrite ? (
    <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
      {t("DashboardPayments.counterparty.detail.addAddress")}
    </Button>
  ) : null;

  return (
    <DashboardWorkspaceOverviewPanel>
      <DashboardPageTitle title={counterparty.displayName} />
      <div className="flex flex-col gap-6" data-counterparty-detail>
        <ContactRecord
          counterparty={counterparty}
          payouts={payouts}
          payoutsTotal={payoutsTotal}
          payoutsFailed={payoutsFailed}
        />

        <DetailBlock
          title={t("DashboardPayments.counterparty.detail.addresses")}
          // The empty state holds the add button; a failed read's holds a retry instead.
          aside={accounts.length === 0 && !accountsFailed ? undefined : addAddressButton}
        >
          <SavedAddresses
            accounts={accounts}
            read={accountsFailed ? null : { count: initialAccounts.length, total: accountsTotal }}
            addAddressButton={addAddressButton}
          />
        </DetailBlock>

        {rampsEnabled ? (
          <DetailBlock title={t("DashboardPayments.counterparty.detail.providerAccounts")}>
            <CounterpartyProviderAccounts
              accounts={providerAccounts.data}
              error={providerAccounts.error}
            />
          </DetailBlock>
        ) : null}

        <DetailBlock
          title={t("DashboardPayments.counterparty.detail.payments")}
          aside={
            recentTransfers.length === 0 ? undefined : (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={href(
                    `/dashboard/payments/transactions?counterpartyId=${encodeURIComponent(counterparty.id)}`
                  )}
                >
                  {t("DashboardPayments.counterparty.detail.seeAllInTransactions")}
                </Link>
              </Button>
            )
          }
        >
          <RecentPayments
            transfers={recentTransfers}
            failed={transfersFailed}
            onSelect={setSelectedTransfer}
          />
        </DetailBlock>

        <DetailBlock title={t("DashboardPayments.counterparty.detail.notKeptHere")}>
          <p className="mt-2 max-w-[32em] text-body text-secondary">
            {t("DashboardPayments.counterparty.detail.notKeptHereDescription")}
          </p>
        </DetailBlock>

        {canWrite ? (
          <div className="pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-error-border text-error [--button-height-md:1.875rem] hover:bg-error-bg hover:text-error"
              onClick={() => setDeleteOpen(true)}
            >
              {t("DashboardPayments.counterparty.detail.delete")}
            </Button>
          </div>
        ) : null}
      </div>

      <AddExternalAccountDialog
        isOpen={addOpen}
        counterpartyId={counterparty.id}
        onAdded={(account) => setAdded((prev) => [account, ...prev])}
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

/** What a contact's page reads: the contact, its addresses and accounts, and its transfers. */
function counterpartyDetailReads(key: DashboardRequestKey): boolean {
  return counterpartyReads(key) || paymentTransferReads(key);
}

/** A contact's settled payouts up to the key's `cap`; a page that fails ends the read there. */
async function readCounterpartyPayouts(
  key: DashboardRequestKey
): Promise<{ payouts: PaymentTransferSummary[]; total: number; complete: boolean }> {
  const { cap, ...params } = key[3] ?? {};
  const scope = { projectId: key[0], mode: key[1] };
  const pageKey = (page: number) => dashboardRequestKey(scope, key[2], { ...params, page });
  const first = await readDashboardRequest(pageKey(1), transferPageResponseSchema);
  const total = Math.max(first.meta.total, first.data.length);
  const pages = Math.ceil(Math.min(total, Number(cap)) / Number(params.pageSize));
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      readDashboardRequest(pageKey(index + 2), transferPageResponseSchema)
    )
  );
  // Keep what was read up to the first failed page: the pages are newest first, so that is
  // still the latest payouts, and `total` says how many more there are.
  const failedAt = rest.findIndex((result) => result.status === "rejected");
  const read = (failedAt === -1 ? rest : rest.slice(0, failedAt)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const seen = new Set<string>();
  const payouts = [first, ...read]
    .flatMap((body) => body.data)
    .filter((transfer) => {
      if (seen.has(transfer.id)) return false;
      seen.add(transfer.id);
      return true;
    })
    .slice(0, Number(cap));
  return { payouts, total: Math.max(total, payouts.length), complete: failedAt === -1 };
}

const COUNTERPARTY_TRANSFERS_PAGE_SIZE = 50;

/** A contact's page: the contact, then its addresses, payments and payouts, each read alone. */
export function CounterpartyDetailRoute({
  counterpartyId,
  rampsEnabled,
}: {
  counterpartyId: string;
  /** Whether provider-owned fiat accounts are available in this deployment. */
  rampsEnabled: boolean;
}) {
  const t = useTranslations();
  const scope = useDashboardKeyScope();
  const contact = useDashboardRead(
    paymentsQueryKeys.counterparty(scope, counterpartyId),
    counterpartyResponseSchema
  );
  const accounts = useDashboardRead(
    paymentsQueryKeys.counterpartyAccounts(scope, counterpartyId),
    counterpartyAccountsResponseSchema
  );
  const transfers = useDashboardRead(
    paymentsQueryKeys.counterpartyTransfers(scope, {
      counterpartyId,
      pageSize: COUNTERPARTY_TRANSFERS_PAGE_SIZE,
    }),
    transferListResponseSchema
  );
  const payouts = useDashboardSWR(
    paymentsQueryKeys.counterpartyPayouts(scope, {
      counterpartyId,
      statuses: SETTLED_PAYOUT_STATUSES,
    }),
    readCounterpartyPayouts
  );
  if (contact.error?.status === 404) {
    return <ProjectNotFound />;
  }
  if (contact.error !== undefined) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <RecordLoadError
          title={t("DashboardPayments.counterparty.detail.loadFailedTitle")}
          description={t("DashboardPayments.counterparty.detail.loadFailedDescription")}
          onRetry={() => void contact.mutate()}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }
  const settled = [accounts, transfers, payouts].every(
    (read) => read.data !== undefined || read.error !== undefined
  );
  if (contact.data === undefined || !settled) {
    return <CounterpartyDetailSkeleton />;
  }
  const accountsBody = accounts.data?.data;
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <CounterpartyDetailWorkspace
        counterparty={contact.data.data.counterparty}
        initialAccounts={accountsBody?.accounts ?? []}
        accountsTotal={Math.max(accountsBody?.total ?? 0, accountsBody?.accounts.length ?? 0)}
        accountsFailed={accounts.error !== undefined}
        initialTransfers={transfers.data?.data ?? []}
        transfersFailed={transfers.error !== undefined}
        payouts={payouts.data?.payouts ?? []}
        payoutsTotal={payouts.data?.total ?? 0}
        payoutsFailed={payouts.data === undefined || !payouts.data.complete}
        rampsEnabled={rampsEnabled}
      />
    </div>
  );
}
