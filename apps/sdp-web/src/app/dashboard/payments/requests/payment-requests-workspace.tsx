"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type Counterparty,
  type PaymentRequest,
  type PaymentRequestStatus,
  type PaymentsDashboardWallet,
} from "@sdp/types";
import { CopyIcon } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { Modal } from "@/components/ui/modal";
import { SearchInput } from "@/components/ui/search-input";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { PAYMENT_REQUEST_NEW_HREF, PAYMENT_REQUEST_OPEN_PARAM } from "@/lib/payments-routes";
import { cn } from "@/lib/utils";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../payments-table";
import {
  deriveTokenOptions,
  type PaymentRequestsLocalErrorCode,
} from "./payment-requests-page.data";

const STATUS_TRANSLATION_KEYS = {
  awaiting_payment: "DashboardPayments.requests.awaitingPayment",
  paid: "DashboardPayments.requests.paid",
  canceled: "DashboardPayments.requests.canceled",
  expired: "DashboardPayments.requests.expired",
} as const satisfies Record<PaymentRequestStatus, MessageKey>;

const REQUEST_STATUS_TONE = {
  paid: "positive",
  awaiting_payment: "attention",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentRequestStatus, StatusTone>;

function StatusBadge({
  status,
  className = "text-body",
}: {
  status: PaymentRequestStatus;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <StatusText tone={REQUEST_STATUS_TONE[status]} className={className}>
      {t(STATUS_TRANSLATION_KEYS[status])}
    </StatusText>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-secondary">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-primary">
        {children}
      </span>
    </div>
  );
}

interface PaymentRequestsWorkspaceProps {
  initialPaymentRequests: PaymentRequest[];
  initialError?: string;
  initialLocalErrorCode?: PaymentRequestsLocalErrorCode;
  wallets: PaymentsDashboardWallet[];
  counterparties: Counterparty[];
  /** The project's full request count; more than the rows given when the load was capped. */
  total?: number;
}

const REQUEST_STATUSES = Object.keys(STATUS_TRANSLATION_KEYS) as PaymentRequestStatus[];

/** Says when the load cap left older requests out, so search and filters are known to miss them. */
function DirectoryCapNotice({ count, total }: { count: number; total: number }) {
  const t = useTranslations();
  if (total <= count) {
    return null;
  }
  return (
    <p className="text-meta text-tertiary">
      {t("DashboardPayments.requests.directoryCapped", { count, total })}
    </p>
  );
}

/** The list's rows: status, amount, who pays, where to, when, and a copy of the link. */
function PaymentRequestsTable({
  rows,
  locale,
  amountLabel,
  fromLabel,
  onSelect,
  onCopyLink,
}: {
  rows: readonly PaymentRequest[];
  locale: string;
  amountLabel: (request: PaymentRequest) => string;
  fromLabel: (counterpartyId: string | null) => string;
  onSelect: (request: PaymentRequest) => void;
  onCopyLink: (request: PaymentRequest) => void;
}) {
  const t = useTranslations();
  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table className="min-w-[760px] rounded-none border-0">
        <TableHeader>
          <TableRow>
            <TableHead className={PAYMENTS_TABLE_HEAD}>{t("DashboardPayments.status")}</TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "text-right")}>
              {t("DashboardPayments.requests.amount")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.requests.from")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.requests.to")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.recurring.created")}
            </TableHead>
            <TableHead className="w-px">
              <span className="sr-only">{t("Shared.SharedComponents.copyLink")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((request) => (
            <TableRow
              key={request.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(request)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(request);
                }
              }}
              className="cursor-pointer"
            >
              <TableCell className={PAYMENTS_TABLE_CELL}>
                <StatusBadge status={request.status} className={PAYMENTS_TABLE_CELL} />
              </TableCell>
              <TableCell
                className={cn(
                  PAYMENTS_TABLE_CELL,
                  "text-right font-medium whitespace-nowrap text-primary tabular-nums"
                )}
              >
                {amountLabel(request)}
              </TableCell>
              <TableCell
                className={cn(
                  PAYMENTS_TABLE_CELL,
                  "max-w-56 truncate",
                  request.counterpartyId ? "text-primary" : "text-tertiary"
                )}
              >
                {fromLabel(request.counterpartyId)}
              </TableCell>
              <TableCell
                className={cn(PAYMENTS_TABLE_CELL, "whitespace-nowrap text-secondary tabular-nums")}
              >
                {shortenAddress(request.destinationAddress)}
              </TableCell>
              <TableCell
                className={cn(PAYMENTS_TABLE_CELL, "whitespace-nowrap text-secondary tabular-nums")}
              >
                {formatDateTime(request.createdAt, locale)}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  iconLeft={<CopyIcon />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopyLink(request);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {t("Shared.SharedComponents.copyLink")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One request in full: its amount, its link to copy, and where it came from and goes. */
function PaymentRequestDetailsModal({
  request,
  payLink,
  fromLabel,
  walletName,
  tokenSymbol,
  onClose,
}: {
  request: PaymentRequest;
  payLink: string;
  fromLabel: string;
  walletName: string | null | undefined;
  tokenSymbol: string | undefined;
  onClose: () => void;
}) {
  const t = useTranslations();
  const tokenLabel = tokenSymbol ? tokenSymbol : shortenAddress(request.token);
  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPayments.requests.paymentRequestDetails")}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-primary">
              {t("DashboardPayments.requests.paymentRequest")}
            </h2>
            <p className="text-sm text-secondary">{formatTimestamp(request.createdAt, t)}</p>
          </div>
          <StatusBadge status={request.status} />
        </div>

        <div className="rounded-2xl bg-fill-subtle p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-secondary">
            {t("DashboardPayments.requests.amountRequested")}
          </p>
          <p className="truncate text-xl font-semibold tracking-tight text-primary">
            {formatDisplayAmount(request.amount, tokenLabel)}
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-border-default p-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-secondary">
            {payLink}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            iconLeft={<CopyIcon />}
            onClick={() => {
              void navigator.clipboard.writeText(payLink);
              toast.success(t("DashboardPayments.requests.paymentLinkCopied"));
            }}
          >
            {t("DashboardPayments.requests.copy")}
          </Button>
        </div>

        <div className="rounded-2xl border border-border-default px-4">
          <div className="divide-y divide-border-default">
            <DetailRow label={t("DashboardPayments.requests.from")}>{fromLabel}</DetailRow>
            <DetailRow label={t("DashboardPayments.requests.to")}>
              {walletName ? (
                <span className="block font-medium text-primary">{walletName}</span>
              ) : null}
              <span className="block font-mono text-xs font-normal text-secondary">
                {request.destinationAddress}
              </span>
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.token")}>{tokenLabel}</DetailRow>
            <DetailRow label={t("DashboardPayments.requests.reference")}>
              {shortenAddress(request.reference)}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.expires")}>
              {request.expiresAt
                ? formatTimestamp(request.expiresAt, t)
                : t("DashboardPayments.requests.noExpiry")}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.recurring.created")}>
              {formatTimestamp(request.createdAt, t)}
            </DetailRow>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The Requests list. The API has no search, so the page loads the newest requests up to a cap
 * and search, the status filter and paging all run over those here. When the cap cut the list
 * short, the list says so.
 */
export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  wallets,
  counterparties,
  total = initialPaymentRequests.length,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { searchParams, replaceSearchParams } = useDashboardUrlState();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PaymentRequestStatus | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const requests = initialPaymentRequests;
  const openRequestedId = searchParams.get(PAYMENT_REQUEST_OPEN_PARAM);

  // The new-request page lands here with ?request=<id>: open that request once, then drop the
  // param so a refresh or the back button does not reopen it.
  useEffect(() => {
    if (!openRequestedId) return;
    const requested = requests.find((request) => request.id === openRequestedId);
    if (requested) setSelected(requested);
    replaceSearchParams({ [PAYMENT_REQUEST_OPEN_PARAM]: null });
  }, [openRequestedId, requests, replaceSearchParams]);

  const payLink = selected ? `${window.location.origin}/pay/${selected.publicToken}` : null;

  const walletNameById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.walletId, wallet.label])),
    [wallets]
  );
  const tokenSymbolByMint = useMemo(
    () => new Map(tokens.map((token) => [token.mintAddress, token.symbol])),
    [tokens]
  );
  const counterpartyNameById = useMemo(
    () =>
      new Map(counterparties.map((counterparty) => [counterparty.id, counterparty.displayName])),
    [counterparties]
  );
  const fromLabel = (counterpartyId: string | null): string => {
    if (!counterpartyId) {
      return t("DashboardPayments.requests.anyone");
    }
    const name = counterpartyNameById.get(counterpartyId);
    return name ? name : counterpartyId;
  };
  const amountLabel = (request: PaymentRequest) => {
    const symbol = tokenSymbolByMint.get(request.token);
    return `${formatDecimalAmount(request.amount, locale)} ${symbol ? symbol : shortenAddress(request.token)}`;
  };
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      if (statusFilter !== undefined && request.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        request.amount,
        tokenSymbolByMint.get(request.token) ?? request.token,
        request.counterpartyId ? (counterpartyNameById.get(request.counterpartyId) ?? "") : "",
        request.destinationAddress,
        request.reference,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [requests, statusFilter, query, tokenSymbolByMint, counterpartyNameById]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const copyLink = (request: PaymentRequest) => {
    void navigator.clipboard.writeText(`${window.location.origin}/pay/${request.publicToken}`);
    toast.success(t("DashboardPayments.requests.paymentLinkCopied"));
  };

  return (
    <>
      <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
        {initialError || initialLocalErrorCode ? (
          <p className="text-body text-error">
            {initialError ?? t("DashboardPayments.requests.loadFailed")}
          </p>
        ) : requests.length === 0 ? (
          <ListEmptyState
            hidesPageAction
            message={t("DashboardPayments.requests.emptyTitle")}
            description={t("DashboardPayments.requests.emptyDescription")}
            action={
              <Button asChild size="sm">
                <Link href={PAYMENT_REQUEST_NEW_HREF}>
                  {t("DashboardPayments.requests.newRequest")}
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            <ListToolbar
              filters={
                <FilterMenu
                  label={t("Shared.SharedComponents.filter")}
                  searchPlaceholder={t("Shared.SharedComponents.filterBy")}
                  sections={[
                    {
                      id: "status",
                      label: t("DashboardPayments.status"),
                      value:
                        statusFilter === undefined
                          ? undefined
                          : t(STATUS_TRANSLATION_KEYS[statusFilter]),
                      content: (
                        <FilterMenuOptions
                          value={statusFilter}
                          anyLabel={t("Shared.SharedComponents.any")}
                          options={REQUEST_STATUSES.map((status) => ({
                            value: status,
                            label: t(STATUS_TRANSLATION_KEYS[status]),
                          }))}
                          onChange={(value) => {
                            setStatusFilter(REQUEST_STATUSES.find((status) => status === value));
                            setPage(1);
                          }}
                        />
                      ),
                    },
                  ]}
                />
              }
            >
              <RowsPerPageSelect
                value={pageSize}
                onChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
              <SearchInput
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                clear={{
                  label: t("DashboardPayments.requests.clearSearch"),
                  onClear: () => setQuery(""),
                }}
                placeholder={t("DashboardPayments.requests.searchPlaceholder")}
                className="min-w-0 flex-1 sm:w-56 sm:flex-none"
              />
            </ListToolbar>
            <DirectoryCapNotice count={requests.length} total={total} />
            {rows.length === 0 ? (
              <p className="py-12 text-center text-body text-tertiary">
                {t("DashboardPayments.requests.noMatches")}
              </p>
            ) : (
              <PaymentRequestsTable
                rows={rows}
                locale={locale}
                amountLabel={amountLabel}
                fromLabel={fromLabel}
                onSelect={setSelected}
                onCopyLink={copyLink}
              />
            )}
            {filtered.length > pageSize ? (
              <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
            ) : null}
          </>
        )}
      </DashboardWorkspaceOverviewPanel>

      {selected && payLink ? (
        <PaymentRequestDetailsModal
          request={selected}
          payLink={payLink}
          fromLabel={fromLabel(selected.counterpartyId)}
          walletName={walletNameById.get(selected.walletId)}
          tokenSymbol={tokenSymbolByMint.get(selected.token)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}
