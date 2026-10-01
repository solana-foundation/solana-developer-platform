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
import { type KeyboardEvent, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { StatusText } from "@/components/ui/status-text";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import {
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUESTS_HREF,
  paymentRequestHref,
} from "@/lib/payments-routes";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { PAYMENTS_TABLE_CELL } from "../payments-table";
import { PaymentsTableHeader } from "../payments-table-header";
import { REQUEST_STATUS_TONE, REQUEST_STATUS_TRANSLATION_KEYS } from "./payment-request-status";
import {
  deriveTokenOptions,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  type PaymentRequestsListState,
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
  /** How many requests match the status filter, across every page. */
  total: number;
  listState: PaymentRequestsListState;
}

const REQUEST_STATUSES = Object.keys(REQUEST_STATUS_TRANSLATION_KEYS) as PaymentRequestStatus[];

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
        <PaymentsTableHeader
          columns={[
            { id: "status", label: t("DashboardPayments.status") },
            {
              id: "amount",
              label: t("DashboardPayments.requests.amount"),
              className: "text-right",
            },
            { id: "from", label: t("DashboardPayments.requests.from") },
            { id: "to", label: t("DashboardPayments.requests.to") },
            { id: "created", label: t("DashboardPayments.recurring.created") },
            {
              id: "copy",
              label: <span className="sr-only">{t("Shared.SharedComponents.copyLink")}</span>,
              className: "w-px",
            },
          ]}
        />
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
 * The Requests list. The status filter and the page live in the URL and load on the server, one
 * page at a time; search runs here over the loaded page, because the API has none.
 */
export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  counterparties,
  total,
  listState,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const demo = usePaymentsDemo();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const requests = initialPaymentRequests;
  const statusFilter = listState.status ?? undefined;

  const applyListParams = (updates: {
    page?: number;
    pageSize?: number;
    status?: PaymentRequestStatus | null;
  }) => {
    const params = new URLSearchParams(window.location.search);
    if (updates.page !== undefined) {
      if (updates.page === 1) {
        params.delete("page");
      } else {
        params.set("page", String(updates.page));
      }
    }
    if (updates.pageSize !== undefined) {
      params.delete("page");
      if (updates.pageSize === PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE) {
        params.delete("pageSize");
      } else {
        params.set("pageSize", String(updates.pageSize));
      }
    }
    if (updates.status !== undefined) {
      params.delete("page");
      if (updates.status === null) {
        params.delete("status");
      } else {
        params.set("status", updates.status);
      }
    }
    const search = params.toString();
    startTransition(() =>
      router.replace(`${PAYMENT_REQUESTS_HREF}${search ? `?${search}` : ""}`, { scroll: false })
    );
  };
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
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
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
  }, [requests, query, tokenSymbolByMint, counterpartyNameById]);
  const pageCount = Math.max(1, Math.ceil(total / listState.pageSize));
  const rangeStart = total === 0 ? 0 : (listState.page - 1) * listState.pageSize + 1;
  const rangeEnd = Math.min(listState.page * listState.pageSize, total);
  const listIsEmpty = total === 0 && listState.status === null;

  const copyLink = (request: PaymentRequest) => {
    // A demo request lives in this browser only, so the public pay page can't open its link.
    if (demo) {
      toast.info(t("DashboardPayments.demo.noPayLink"));
      return;
    }
    void navigator.clipboard.writeText(`${window.location.origin}/pay/${request.publicToken}`);
    toast.success(t("DashboardPayments.requests.paymentLinkCopied"));
  };

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
      {initialError || initialLocalErrorCode ? (
        <p className="text-body text-error">
          {initialError ?? t("DashboardPayments.requests.loadFailed")}
        </p>
      ) : listIsEmpty ? (
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
                        onChange={(value) =>
                          applyListParams({
                            status: REQUEST_STATUSES.find((status) => status === value) ?? null,
                          })
                        }
                      />
                    ),
                  },
                ]}
              />
            }
          >
            <RowsPerPageSelect
              value={listState.pageSize}
              onChange={(pageSize) => applyListParams({ pageSize })}
            />
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              clear={{
                label: t("DashboardPayments.requests.clearSearch"),
                onClear: () => setQuery(""),
              }}
              placeholder={t("DashboardPayments.requests.searchPlaceholder")}
              className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            />
          </ListToolbar>
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
          <ArrowPagination
            page={listState.page}
            pageCount={pageCount}
            onPageChange={(page) => applyListParams({ page })}
            disabled={isPending}
            summary={t("DashboardPayments.requests.range", {
              from: rangeStart,
              to: rangeEnd,
              total,
            })}
          />
        </>
      )}
    </DashboardWorkspaceOverviewPanel>
  );
}
