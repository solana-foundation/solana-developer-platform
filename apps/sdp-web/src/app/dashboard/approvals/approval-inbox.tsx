"use client";

import type {
  ApprovalRequestStatus,
  WalletApprovalRequestSummary,
  WalletOperationFamily,
} from "@sdp/types";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { ApprovalStatusBadge } from "./approval-request-shared";
import {
  APPROVAL_HISTORY_STATUSES,
  APPROVAL_INBOX_PAGE_SIZE,
  APPROVAL_OPERATION_FAMILIES,
  type ApprovalInboxFilters,
  type ApprovalInboxTab,
  approvalAmount,
  approvalApiKeyLabel,
  approvalReason,
  approvalWalletLabel,
  EMPTY_APPROVAL_FILTERS,
  filterApprovalRequests,
  formatApprovalLabel,
  formatApprovalRelativeTime,
  hasApprovalFilters,
  mergeApprovalRequests,
  shortApprovalIdentifier,
} from "./approval-requests.data";

const filterControlClassName =
  "h-10 w-full rounded-md border border-border-default bg-white px-3 text-sm text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:ring-2 focus:ring-primary/10";

function approvalRequestHref(approvalRequestId: string): string {
  return `/dashboard/approvals/${encodeURIComponent(approvalRequestId)}`;
}

interface ApprovalInboxProps {
  initialRequests: WalletApprovalRequestSummary[];
  apiKeyNames: Record<string, string>;
  canDecide: boolean;
  initialTab: ApprovalInboxTab;
  renderedAt: number;
  loadError?: boolean;
}

export function ApprovalInbox({
  initialRequests,
  apiKeyNames,
  canDecide,
  initialTab,
  renderedAt,
  loadError = false,
}: ApprovalInboxProps) {
  const t = useTranslations();
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const [requests, setRequests] = useState(initialRequests);
  const [tab, setTab] = useState<ApprovalInboxTab>(initialTab);
  const [filters, setFilters] = useState<ApprovalInboxFilters>(EMPTY_APPROVAL_FILTERS);
  const [page, setPage] = useState(1);
  const [isReloading, setReloading] = useState(false);
  const [hasLoadError, setLoadError] = useState(loadError);
  const [relativeTimeBase, setRelativeTimeBase] = useState(renderedAt);

  const pendingCount = useMemo(
    () => requests.filter((request) => request.status === "pending").length,
    [requests]
  );
  const walletOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const request of requests) {
      options.set(request.operation.walletId, approvalWalletLabel(request));
    }
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [requests]);
  const apiKeyOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const request of requests) {
      const apiKeyId = request.operation.apiKeyId;
      if (apiKeyId)
        options.set(apiKeyId, apiKeyNames[apiKeyId] || shortApprovalIdentifier(apiKeyId));
    }
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [apiKeyNames, requests]);
  const filteredRequests = useMemo(
    () => filterApprovalRequests(requests, tab, filters),
    [filters, requests, tab]
  );
  const pageCount = Math.max(1, Math.ceil(filteredRequests.length / APPROVAL_INBOX_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleRequests = filteredRequests.slice(
    (currentPage - 1) * APPROVAL_INBOX_PAGE_SIZE,
    currentPage * APPROVAL_INBOX_PAGE_SIZE
  );
  const rangeStart =
    filteredRequests.length === 0 ? 0 : (currentPage - 1) * APPROVAL_INBOX_PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * APPROVAL_INBOX_PAGE_SIZE, filteredRequests.length);

  function updateFilter<TKey extends keyof ApprovalInboxFilters>(
    key: TKey,
    value: ApprovalInboxFilters[TKey]
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function selectTab(nextTab: ApprovalInboxTab) {
    setTab(nextTab);
    setFilters(EMPTY_APPROVAL_FILTERS);
    setPage(1);
  }

  async function reload() {
    setReloading(true);
    try {
      const [pendingResponse, recentResponse] = await Promise.all([
        fetch("/api/dashboard/approval-requests?status=pending&limit=100", {
          cache: "no-store",
        }),
        fetch("/api/dashboard/approval-requests?limit=100", { cache: "no-store" }),
      ]);
      const [pendingBody, recentBody] = (await Promise.all([
        pendingResponse.json().catch(() => null),
        recentResponse.json().catch(() => null),
      ])) as Array<{
        data?: { approvalRequests?: WalletApprovalRequestSummary[] };
      } | null>;
      const pendingRequests = pendingBody?.data?.approvalRequests;
      const recentRequests = recentBody?.data?.approvalRequests;
      if (!pendingResponse.ok || !recentResponse.ok || !pendingRequests || !recentRequests) {
        throw new Error("Approval reload failed");
      }
      setRequests(mergeApprovalRequests(pendingRequests, recentRequests));
      setRelativeTimeBase(Date.now());
      setLoadError(false);
      window.dispatchEvent(new Event("sdp:approval-requests-updated"));
    } catch {
      setLoadError(true);
      if (requests.length > 0) {
        toast.error(t("DashboardApprovals.refreshFailed"), { position: "bottom-right" });
      }
    } finally {
      setReloading(false);
    }
  }

  if (hasLoadError && requests.length === 0) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-medium text-primary">
            {t("DashboardApprovals.unableToLoad")}
          </h1>
          <p className="mt-2 text-sm text-secondary">
            {t("DashboardApprovals.unableToLoadDescription")}
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={reload}
            disabled={isReloading}
            iconLeft={<RotateCw className={isReloading ? "size-4 animate-spin" : "size-4"} />}
          >
            {t("DashboardApprovals.reload")}
          </Button>
        </div>
      </div>
    );
  }

  const emptyFiltered = hasApprovalFilters(filters);
  const emptyTitle = emptyFiltered
    ? t("DashboardApprovals.emptyFiltered")
    : tab === "pending"
      ? t("DashboardApprovals.emptyPending")
      : t("DashboardApprovals.emptyHistory");
  const emptyDescription = emptyFiltered
    ? t("DashboardApprovals.emptyFilteredDescription")
    : tab === "pending"
      ? t("DashboardApprovals.emptyPendingDescription")
      : t("DashboardApprovals.emptyHistoryDescription");

  return (
    <div className="h-full overflow-y-auto px-3 pb-8 outline-none md:px-6">
      <div className="mx-auto w-full max-w-[1500px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium text-primary sm:text-3xl">
              {t("DashboardApprovals.title")}
            </h1>
            <p className="mt-1 text-sm text-secondary">{t("DashboardApprovals.description")}</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-secondary">
            <span>{t("DashboardApprovals.pendingCount", { count: pendingCount })}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={reload}
              disabled={isReloading}
              aria-label={t("DashboardApprovals.reload")}
              title={t("DashboardApprovals.reload")}
            >
              <RotateCw className={isReloading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </header>

        {!canDecide ? (
          <p className="mt-4 border-y border-border-default bg-fill-subtle px-3 py-2 text-sm text-secondary">
            {t("DashboardApprovals.viewOnly")}
          </p>
        ) : null}

        <div
          className="mt-6 flex h-10 items-end gap-8 border-b border-border-default"
          role="tablist"
          aria-label={t("DashboardApprovals.title")}
        >
          <TabButton active={tab === "pending"} onClick={() => selectTab("pending")}>
            {t("DashboardApprovals.pendingTab")}
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => selectTab("history")}>
            {t("DashboardApprovals.historyTab")}
          </TabButton>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <ApprovalFilters
              tab={tab}
              filters={filters}
              walletOptions={walletOptions}
              apiKeyOptions={apiKeyOptions}
              updateFilter={updateFilter}
              clear={() => {
                setFilters(EMPTY_APPROVAL_FILTERS);
                setPage(1);
              }}
            />

            {visibleRequests.length === 0 ? (
              <div className="border-y border-border-default py-16 text-center">
                <p className="text-sm font-medium text-primary">{emptyTitle}</p>
                <p className="mt-1 text-sm text-secondary">{emptyDescription}</p>
              </div>
            ) : (
              <ApprovalRequestRows
                requests={visibleRequests}
                apiKeyNames={apiKeyNames}
                locale={locale}
                relativeTimeBase={relativeTimeBase}
              />
            )}
          </motion.div>
        </AnimatePresence>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-secondary">
            {t("DashboardApprovals.range", {
              from: rangeStart,
              to: rangeEnd,
              total: filteredRequests.length,
            })}
          </p>
          {pageCount > 1 ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={currentPage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                aria-label={t("DashboardApprovals.previousPage")}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-20 text-center text-xs text-secondary">
                {t("DashboardApprovals.pageOf", { page: currentPage, pageCount })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                aria-label={t("DashboardApprovals.nextPage")}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "relative h-10 text-sm font-medium text-primary after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:bg-primary"
          : "h-10 text-sm font-medium text-secondary transition-colors hover:text-primary"
      }
    >
      {children}
    </button>
  );
}

function ApprovalFilters({
  tab,
  filters,
  walletOptions,
  apiKeyOptions,
  updateFilter,
  clear,
}: {
  tab: ApprovalInboxTab;
  filters: ApprovalInboxFilters;
  walletOptions: [string, string][];
  apiKeyOptions: [string, string][];
  updateFilter: <TKey extends keyof ApprovalInboxFilters>(
    key: TKey,
    value: ApprovalInboxFilters[TKey]
  ) => void;
  clear: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="grid gap-3 border-b border-border-default py-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-[repeat(4,minmax(140px,1fr))_minmax(135px,0.75fr)_minmax(135px,0.75fr)_auto]">
      <FilterField label={t("DashboardApprovals.walletFilter")}>
        <select
          value={filters.walletId}
          onChange={(event) => updateFilter("walletId", event.target.value)}
          className={filterControlClassName}
        >
          <option value="">{t("DashboardApprovals.allWallets")}</option>
          {walletOptions.map(([walletId, label]) => (
            <option key={walletId} value={walletId}>
              {label}
            </option>
          ))}
        </select>
      </FilterField>

      {tab === "history" ? (
        <FilterField label={t("DashboardApprovals.statusFilter")}>
          <select
            value={filters.status}
            onChange={(event) =>
              updateFilter("status", event.target.value as "" | ApprovalRequestStatus)
            }
            className={filterControlClassName}
          >
            <option value="">{t("DashboardApprovals.allStatuses")}</option>
            {APPROVAL_HISTORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formatApprovalLabel(status)}
              </option>
            ))}
          </select>
        </FilterField>
      ) : (
        <FilterField label={t("DashboardApprovals.operationFilter")}>
          <select
            value={filters.operationFamily}
            onChange={(event) =>
              updateFilter("operationFamily", event.target.value as "" | WalletOperationFamily)
            }
            className={filterControlClassName}
          >
            <option value="">{t("DashboardApprovals.allOperations")}</option>
            {APPROVAL_OPERATION_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {formatApprovalLabel(family)}
              </option>
            ))}
          </select>
        </FilterField>
      )}

      {tab === "history" ? (
        <FilterField label={t("DashboardApprovals.operationFilter")}>
          <select
            value={filters.operationFamily}
            onChange={(event) =>
              updateFilter("operationFamily", event.target.value as "" | WalletOperationFamily)
            }
            className={filterControlClassName}
          >
            <option value="">{t("DashboardApprovals.allOperations")}</option>
            {APPROVAL_OPERATION_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {formatApprovalLabel(family)}
              </option>
            ))}
          </select>
        </FilterField>
      ) : null}

      <FilterField label={t("DashboardApprovals.apiKeyFilter")}>
        <select
          value={filters.apiKeyId}
          onChange={(event) => updateFilter("apiKeyId", event.target.value)}
          className={filterControlClassName}
        >
          <option value="">{t("DashboardApprovals.allApiKeys")}</option>
          {apiKeyOptions.map(([apiKeyId, label]) => (
            <option key={apiKeyId} value={apiKeyId}>
              {label}
            </option>
          ))}
        </select>
      </FilterField>

      <FilterField label={t("DashboardApprovals.fromFilter")}>
        <input
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(event) => updateFilter("from", event.target.value)}
          className={filterControlClassName}
        />
      </FilterField>
      <FilterField label={t("DashboardApprovals.toFilter")}>
        <input
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(event) => updateFilter("to", event.target.value)}
          className={filterControlClassName}
        />
      </FilterField>
      <div className="flex items-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={!hasApprovalFilters(filters)}
        >
          {t("DashboardApprovals.clearFilters")}
        </Button>
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="block text-xs font-medium text-secondary">{label}</legend>
      {children}
    </fieldset>
  );
}

function ApprovalRequestRows({
  requests,
  apiKeyNames,
  locale,
  relativeTimeBase,
}: {
  requests: WalletApprovalRequestSummary[];
  apiKeyNames: Record<string, string>;
  locale: string;
  relativeTimeBase: number;
}) {
  const t = useTranslations();
  return (
    <>
      <div className="divide-y divide-border-default border-b border-border-default 2xl:hidden">
        {requests.map((request) => {
          const reason = approvalReason(request, t("DashboardApprovals.approvalRequiredByPolicy"));
          const apiKeyLabel = approvalApiKeyLabel(
            request,
            apiKeyNames,
            t("DashboardApprovals.directRequest")
          );
          return (
            <Link
              key={request.id}
              href={approvalRequestHref(request.id)}
              className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4 outline-none transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ApprovalStatusBadge status={request.status} />
                  <span className="text-xs text-secondary">
                    {formatApprovalRelativeTime(request.createdAt, locale, relativeTimeBase)}
                  </span>
                </div>
                <p className="mt-3 text-sm font-medium text-primary">
                  {formatApprovalLabel(request.operation.operationFamily)}
                </p>
                <p className="mt-1 text-sm text-secondary">{reason}</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <MobileValue
                    label={t("DashboardApprovals.walletColumn")}
                    value={approvalWalletLabel(request)}
                  />
                  <MobileValue
                    label={t("DashboardApprovals.amountAssetColumn")}
                    value={approvalAmount(request)}
                  />
                  <MobileValue
                    label={t("DashboardApprovals.requestedByColumn")}
                    value={apiKeyLabel}
                  />
                  <MobileValue
                    label={t("DashboardApprovals.destinationColumn")}
                    value={shortApprovalIdentifier(request.operation.destination)}
                  />
                </dl>
              </div>
              <ChevronRight className="mt-1 size-4 text-tertiary transition-transform group-hover:translate-x-0.5" />
            </Link>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto 2xl:block">
        <Table className="min-w-0 [&_table]:min-w-[1118px] [&_table]:table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[88px]">{t("DashboardApprovals.statusColumn")}</TableHead>
              <TableHead className="w-[145px]">{t("DashboardApprovals.walletColumn")}</TableHead>
              <TableHead className="w-[145px]">{t("DashboardApprovals.operationColumn")}</TableHead>
              <TableHead className="w-[120px]">
                {t("DashboardApprovals.amountAssetColumn")}
              </TableHead>
              <TableHead className="w-[120px]">
                {t("DashboardApprovals.destinationColumn")}
              </TableHead>
              <TableHead className="w-[145px]">
                {t("DashboardApprovals.requestedByColumn")}
              </TableHead>
              <TableHead className="w-[200px]">
                {t("DashboardApprovals.policyReasonColumn")}
              </TableHead>
              <TableHead className="w-[115px]">{t("DashboardApprovals.submittedColumn")}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("DashboardApprovals.openRequest")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => {
              const href = approvalRequestHref(request.id);
              const reason = approvalReason(
                request,
                t("DashboardApprovals.approvalRequiredByPolicy")
              );
              const apiKeyLabel = approvalApiKeyLabel(
                request,
                apiKeyNames,
                t("DashboardApprovals.directRequest")
              );
              return (
                <TableRow key={request.id} className="group hover:bg-fill-subtle">
                  <ApprovalCell>
                    <ApprovalStatusBadge status={request.status} />
                  </ApprovalCell>
                  <ApprovalCell>
                    <Link href={href} className="font-medium text-primary hover:underline">
                      {approvalWalletLabel(request)}
                    </Link>
                    <p
                      className="mt-1 truncate text-xs text-tertiary"
                      title={request.wallet?.publicKey ?? request.operation.walletId}
                    >
                      {shortApprovalIdentifier(
                        request.wallet?.publicKey ?? request.operation.walletId
                      )}
                    </p>
                  </ApprovalCell>
                  <ApprovalCell>
                    <p className="font-medium text-primary">
                      {formatApprovalLabel(request.operation.operationFamily)}
                    </p>
                    <p
                      className="mt-1 truncate text-xs text-tertiary"
                      title={request.operation.operationType}
                    >
                      {request.operation.operationType}
                    </p>
                  </ApprovalCell>
                  <ApprovalCell>{approvalAmount(request)}</ApprovalCell>
                  <ApprovalCell>
                    <span title={request.operation.destination ?? undefined}>
                      {shortApprovalIdentifier(request.operation.destination)}
                    </span>
                  </ApprovalCell>
                  <ApprovalCell>
                    <p className="line-clamp-2">{apiKeyLabel}</p>
                    {request.operation.apiKeyId ? (
                      <p
                        className="mt-1 truncate text-xs text-tertiary"
                        title={request.operation.apiKeyId}
                      >
                        {shortApprovalIdentifier(request.operation.apiKeyId)}
                      </p>
                    ) : null}
                  </ApprovalCell>
                  <ApprovalCell>
                    <p className="line-clamp-2" title={reason}>
                      {reason}
                    </p>
                  </ApprovalCell>
                  <ApprovalCell>
                    <span title={request.createdAt}>
                      {formatApprovalRelativeTime(request.createdAt, locale, relativeTimeBase)}
                    </span>
                  </ApprovalCell>
                  <TableCell className="px-2">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link href={href} aria-label={t("DashboardApprovals.openRequest")}>
                        <ChevronRight className="size-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function ApprovalCell({ children }: { children: React.ReactNode }) {
  return (
    <TableCell className="min-w-0 overflow-hidden !whitespace-normal px-4 py-3 text-sm font-normal text-primary [overflow-wrap:anywhere]">
      {children}
    </TableCell>
  );
}

function MobileValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-tertiary">{label}</dt>
      <dd className="mt-0.5 truncate text-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}
