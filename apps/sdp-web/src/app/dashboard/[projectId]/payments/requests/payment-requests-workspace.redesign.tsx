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
import {
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUESTS_HREF,
  paymentRequestHref,
} from "@/lib/payments-routes";
import { useProjectHref } from "@/lib/use-dashboard-project";
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
  paymentRequestMatchesSearch,
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
  /** How many requests the API counts for the status filter, across every page. */
  total: number;
  /** Whether `total` is exact; when it is not, the pager shows the page without a count. */
  totalIsExact: boolean;
  /** Whether the API has a page after this one. */
  hasNextPage: boolean;
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

/** The search field, which searches once the user presses Enter, leaves it, or clears it. */
function PaymentRequestsSearch({
  initialValue,
  pending,
  onCommit,
}: {
  initialValue: string;
  pending: boolean;
  onCommit: (value: string) => void;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(initialValue);
  return (
    <SearchInput
      value={value}
      pending={pending}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onCommit(value);
      }}
      clear={{
        label: t("DashboardPayments.requests.clearSearch"),
        onClear: () => {
          setValue("");
          onCommit("");
        },
      }}
      placeholder={t("DashboardPayments.requests.searchPlaceholder")}
      className="min-w-0 flex-1 sm:w-56 sm:flex-none"
    />
  );
}

/** A change to the list's URL; whatever is left out stays as it is. */
interface ListParamsUpdate {
  page?: number;
  pageSize?: number;
  status?: PaymentRequestStatus | null;
  search?: string;
}

function setOrDeleteParam(params: URLSearchParams, key: string, value: string | null) {
  if (value === null) {
    params.delete(key);
  } else {
    params.set(key, value);
  }
}

/**
 * The Requests list's URL after a change, leaving out whatever is at its default. Any change but
 * the page goes back to the first page.
 *
 * @param query - The list's current query string.
 * @param updates - What changes.
 * @param currentSearch - The search the list shows now.
 * @returns The new path, or `null` when only a search was given and it is the one shown.
 */
function listHrefAfter(
  query: string,
  updates: ListParamsUpdate,
  currentSearch: string | null
): string | null {
  const params = new URLSearchParams(query);
  if (updates.page !== undefined) {
    setOrDeleteParam(params, "page", updates.page === 1 ? null : String(updates.page));
  }
  if (updates.pageSize !== undefined) {
    params.delete("page");
    setOrDeleteParam(
      params,
      "pageSize",
      updates.pageSize === PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE ? null : String(updates.pageSize)
    );
  }
  if (updates.status !== undefined) {
    params.delete("page");
    setOrDeleteParam(params, "status", updates.status);
  }
  if (updates.search !== undefined) {
    const search = updates.search.trim();
    if (search === (currentSearch ?? "")) return null;
    params.delete("page");
    setOrDeleteParam(params, "search", search === "" ? null : search);
  }
  const next = params.toString();
  return `${PAYMENT_REQUESTS_HREF}${next ? `?${next}` : ""}`;
}

/** The toolbar's filter menu, which filters the list by status. */
function PaymentRequestsStatusFilter({
  value,
  onChange,
}: {
  value: PaymentRequestStatus | null;
  onChange: (status: PaymentRequestStatus | null) => void;
}) {
  const t = useTranslations();
  return (
    <FilterMenu
      label={t("Shared.SharedComponents.filter")}
      searchPlaceholder={t("Shared.SharedComponents.filterBy")}
      sections={[
        {
          id: "status",
          label: t("DashboardPayments.status"),
          value: value === null ? undefined : t(REQUEST_STATUS_TRANSLATION_KEYS[value]),
          content: (
            <FilterMenuOptions
              value={value ?? undefined}
              anyLabel={t("Shared.SharedComponents.any")}
              options={REQUEST_STATUSES.map((status) => ({
                value: status,
                label: t(REQUEST_STATUS_TRANSLATION_KEYS[status]),
              }))}
              onChange={(next) =>
                onChange(REQUEST_STATUSES.find((status) => status === next) ?? null)
              }
            />
          ),
        },
      ]}
    />
  );
}

/**
 * The pager under the list, with which rows of how many it shows. With a count the list cannot
 * stand behind (an inexact total, or a search, which the API cannot count), it names the page
 * alone and offers the next while the API has one.
 */
function PaymentRequestsPagination({
  total,
  totalIsExact,
  hasNextPage,
  listState,
  pending,
  onPageChange,
}: {
  total: number;
  totalIsExact: boolean;
  hasNextPage: boolean;
  listState: PaymentRequestsListState;
  pending: boolean;
  onPageChange: (page: number) => void;
}) {
  const t = useTranslations();
  const { page, pageSize, search } = listState;
  if (!totalIsExact || search !== null) {
    return (
      <ArrowPagination
        page={page}
        pageCount={hasNextPage ? page + 1 : page}
        onPageChange={onPageChange}
        disabled={pending}
        summary={t("DashboardPayments.requests.pageNumber", { page })}
      />
    );
  }
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  return (
    <ArrowPagination
      page={page}
      pageCount={pageCount}
      onPageChange={onPageChange}
      disabled={pending}
      summary={t("DashboardPayments.requests.range", {
        from: rangeStart,
        to: rangeEnd,
        total,
      })}
    />
  );
}

/** A row's payer, by contact name, and its amount, by token symbol on the current cluster. */
function usePaymentRequestLabels(counterparties: readonly Counterparty[]) {
  const t = useTranslations();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokenSymbolByMint = useMemo(
    () =>
      new Map(
        deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]).map((token) => [
          token.mintAddress,
          token.symbol,
        ])
      ),
    [sdpEnvironment]
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
  return { fromLabel, amountLabel, counterpartyNameById };
}

/**
 * The Requests list. The page, its size, the status filter and the search live in the URL. The
 * page, its size and the status load on the server (see loadPaymentRequestsList); the search is
 * matched here against that page's rows, and stays in the URL as the user pages on.
 */
export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  counterparties,
  total,
  totalIsExact,
  hasNextPage,
  listState,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { fromLabel, amountLabel, counterpartyNameById } = usePaymentRequestLabels(counterparties);
  const router = useRouter();
  const projectHref = useProjectHref();
  const [isPending, startTransition] = useTransition();
  // TODO(api): send the search to GET /v1/payments/requests once it can search. The API lists
  // requests only by page and stored status, so until then the search matches the page the list
  // has read, by amount, token, payer, destination and reference, and the pager carries it to
  // the other pages. Known limitation of the API, not of this list.
  const { search } = listState;
  const rows = useMemo(
    () =>
      search === null
        ? initialPaymentRequests
        : initialPaymentRequests.filter((request) =>
            paymentRequestMatchesSearch(request, search, counterpartyNameById)
          ),
    [initialPaymentRequests, search, counterpartyNameById]
  );

  const applyListParams = (updates: ListParamsUpdate) => {
    const href = listHrefAfter(window.location.search, updates, listState.search);
    if (href === null) return;
    startTransition(() => router.replace(projectHref(href), { scroll: false }));
  };
  const listIsEmpty = total === 0 && listState.status === null && listState.search === null;

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
      ) : listIsEmpty ? (
        <ListEmptyState
          hidesPageAction
          message={t("DashboardPayments.requests.emptyTitle")}
          description={t("DashboardPayments.requests.emptyDescription")}
          action={
            <Button asChild size="sm">
              <Link href={projectHref(PAYMENT_REQUEST_NEW_HREF)}>
                {t("DashboardPayments.requests.newRequest")}
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <ListToolbar
            filters={
              <PaymentRequestsStatusFilter
                value={listState.status}
                onChange={(status) => applyListParams({ status })}
              />
            }
          >
            <RowsPerPageSelect
              value={listState.pageSize}
              onChange={(pageSize) => applyListParams({ pageSize })}
            />
            <PaymentRequestsSearch
              key={listState.search ?? ""}
              initialValue={listState.search ?? ""}
              pending={isPending}
              onCommit={(search) => applyListParams({ search })}
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
              onSelect={(request) => router.push(projectHref(paymentRequestHref(request.id)))}
              onCopyLink={copyLink}
            />
          )}
          <PaymentRequestsPagination
            total={total}
            totalIsExact={totalIsExact}
            hasNextPage={hasNextPage}
            listState={listState}
            pending={isPending}
            onPageChange={(page) => applyListParams({ page })}
          />
        </>
      )}
    </DashboardWorkspaceOverviewPanel>
  );
}
