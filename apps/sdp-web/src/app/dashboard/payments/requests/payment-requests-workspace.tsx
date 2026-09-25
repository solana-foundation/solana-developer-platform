"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type Counterparty,
  type PaymentRequest,
  type PaymentRequestStatus,
} from "@sdp/types";
import { CopyIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { StatusText } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { PAYMENT_REQUEST_NEW_HREF, paymentRequestHref } from "@/lib/payments-routes";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../payments-table";
import { REQUEST_STATUS_TONE, REQUEST_STATUS_TRANSLATION_KEYS } from "./payment-request-status";
import {
  deriveTokenOptions,
  type PaymentRequestsLocalErrorCode,
} from "./payment-requests-page.data";

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
      {t(REQUEST_STATUS_TRANSLATION_KEYS[status])}
    </StatusText>
  );
}

interface PaymentRequestsWorkspaceProps {
  initialPaymentRequests: PaymentRequest[];
  initialError?: string;
  initialLocalErrorCode?: PaymentRequestsLocalErrorCode;
  counterparties: Counterparty[];
  /** The project's full request count; more than the rows given when the load was capped. */
  total?: number;
}

const REQUEST_STATUSES = Object.keys(REQUEST_STATUS_TRANSLATION_KEYS) as PaymentRequestStatus[];

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

/**
 * The Requests list. The API has no search, so the page loads the newest requests up to a cap
 * and search, the status filter and paging all run over those here. When the cap cut the list
 * short, the list says so.
 */
export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  counterparties,
  total = initialPaymentRequests.length,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PaymentRequestStatus | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const requests = initialPaymentRequests;
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
                        : t(REQUEST_STATUS_TRANSLATION_KEYS[statusFilter]),
                    content: (
                      <FilterMenuOptions
                        value={statusFilter}
                        anyLabel={t("Shared.SharedComponents.any")}
                        options={REQUEST_STATUSES.map((status) => ({
                          value: status,
                          label: t(REQUEST_STATUS_TRANSLATION_KEYS[status]),
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
              onSelect={(request) => router.push(paymentRequestHref(request.id))}
              onCopyLink={copyLink}
            />
          )}
          {filtered.length > pageSize ? (
            <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
          ) : null}
        </>
      )}
    </DashboardWorkspaceOverviewPanel>
  );
}
