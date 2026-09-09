"use client";

import {
  ASSET_AUDIT_ACTIONS,
  ASSET_AUDIT_ACTOR_TYPES,
  ASSET_AUDIT_STATUSES,
  type AssetAuditEvent,
} from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { SegmentedControl } from "../../../create/segmented-control";
import { getPageCount, getPageSummary } from "../../../pagination.utils";
import { formatDateTime } from "../../token-management-workspace.utils";
import { fetchAssetAuditHistory } from "../asset-audit.data";
import {
  auditActionIcon,
  auditActionLabel,
  auditActorBadgeClass,
  auditActorTypeLabel,
  auditStatusBadgeClass,
} from "../asset-audit-presentation";
import { TokenTransactionsBrowser } from "../token-transactions-browser";

const PAGE_SIZE = 50;
// Sentinel select value for the "no filter" option (Select treats null/"" as the
// empty placeholder, so the reset option needs a real value). Shared across the
// action/status/type filters — each Select is independent.
const ALL = "__all__";

function ActivityFilters({
  t,
  action,
  status,
  actorType,
  busy,
  onActionChange,
  onStatusChange,
  onActorTypeChange,
}: {
  t: ReturnType<typeof useTranslations>;
  action: string | null;
  status: string | null;
  actorType: string | null;
  // While a fetch is in flight, the selects are blocked (like the button) and
  // show a spinner so filter changes can't stack mid-request.
  busy: boolean;
  onActionChange: (value: string | null) => void;
  onStatusChange: (value: string | null) => void;
  onActorTypeChange: (value: string | null) => void;
}) {
  const spinner = busy ? <Loader2 className="size-3.5 animate-spin" /> : null;
  const [expanded, setExpanded] = useState(false);
  const filterCount = [action, status, actorType].filter(Boolean).length;
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        className="sm:hidden"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {t("DashboardIssuance.simplified.filters")}
        {filterCount ? ` (${filterCount})` : ""}
      </Button>
      <div
        className={`${expanded ? "flex" : "hidden"} mt-3 flex-wrap gap-2 sm:mt-0 sm:flex sm:justify-end`}
      >
        <div className="w-full sm:w-40">
          <Select
            ariaLabel={t("DashboardIssuance.activity.filterLabel")}
            value={action ?? ALL}
            disabled={busy}
            trailing={spinner}
            onValueChange={(value) => onActionChange(value === ALL ? null : value)}
          >
            <SelectItem value={ALL}>{t("DashboardIssuance.activity.filterAll")}</SelectItem>
            {ASSET_AUDIT_ACTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {auditActionLabel(value)}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-40">
          <Select
            ariaLabel={t("DashboardIssuance.activity.columnStatus")}
            value={status ?? ALL}
            disabled={busy}
            trailing={spinner}
            onValueChange={(value) => onStatusChange(value === ALL ? null : value)}
          >
            <SelectItem value={ALL}>{t("DashboardIssuance.activity.filterAllStatuses")}</SelectItem>
            {ASSET_AUDIT_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "failure"
                  ? t("DashboardIssuance.activity.statusFailure")
                  : t("DashboardIssuance.activity.statusSuccess")}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-40">
          <Select
            ariaLabel={t("DashboardIssuance.activity.columnActorType")}
            value={actorType ?? ALL}
            disabled={busy}
            trailing={spinner}
            onValueChange={(value) => onActorTypeChange(value === ALL ? null : value)}
          >
            <SelectItem value={ALL}>{t("DashboardIssuance.activity.filterAllTypes")}</SelectItem>
            {ASSET_AUDIT_ACTOR_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {auditActorTypeLabel(value, t)}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );
}

function ActivityEventRow({
  event,
  locale,
  t,
}: {
  event: AssetAuditEvent;
  locale: ReturnType<typeof useLocale>;
  t: ReturnType<typeof useTranslations>;
}) {
  const ActionIcon = auditActionIcon(event.action);
  return (
    <TableRow data-testid={`audit-row-${event.id}`}>
      <TableCell align="left">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-fill-subtle px-2 py-1 text-xs font-medium text-secondary">
          <ActionIcon className="h-3.5 w-3.5 shrink-0" />
          {auditActionLabel(event.action)}
        </span>
        <span className="mt-1 block text-xs text-tertiary sm:hidden">
          {formatDateTime(event.createdAt, locale)}
        </span>
      </TableCell>
      <TableCell align="left" className="hidden text-sm text-secondary sm:table-cell">
        {event.actorLabel}
      </TableCell>
      <TableCell align="left" className="hidden sm:table-cell">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${auditActorBadgeClass(
            event.actorType
          )}`}
        >
          {auditActorTypeLabel(event.actorType, t)}
        </span>
      </TableCell>
      <TableCell align="left">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${auditStatusBadgeClass(
            event.status
          )}`}
        >
          {event.status === "failure"
            ? t("DashboardIssuance.activity.statusFailure")
            : t("DashboardIssuance.activity.statusSuccess")}
        </span>
      </TableCell>
      <TableCell align="right" numeric className="hidden text-sm text-secondary sm:table-cell">
        {formatDateTime(event.createdAt, locale)}
      </TableCell>
    </TableRow>
  );
}

function ActivityResults({
  t,
  locale,
  isInitialLoading,
  isRefreshing,
  busy,
  errorMessage,
  events,
  total,
  page,
  onPageChange,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  busy: boolean;
  errorMessage: string | null;
  events: AssetAuditEvent[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
}) {
  if (isInitialLoading) {
    return (
      <div aria-busy="true" className="divide-y divide-border-subtle">
        {["a", "b", "c", "d"].map((id) => (
          <div key={id} className="flex justify-between gap-4 py-5">
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="hidden h-4 w-24 sm:block" />
          </div>
        ))}
      </div>
    );
  }
  if (errorMessage) {
    return <p className="text-sm text-error">{errorMessage}</p>;
  }
  if (events.length === 0) {
    return <p className="text-sm text-secondary">{t("DashboardIssuance.activity.empty")}</p>;
  }
  const { pageCount, start, end } = getPageSummary({
    page,
    pageSize: PAGE_SIZE,
    total,
    shown: events.length,
  });
  return (
    <div
      aria-busy={isRefreshing}
      className={`space-y-3 transition-opacity ${isRefreshing ? "opacity-60" : ""}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead align="left">{t("DashboardIssuance.activity.columnAction")}</TableHead>
            <TableHead align="left" className="hidden sm:table-cell">
              {t("DashboardIssuance.activity.columnActor")}
            </TableHead>
            <TableHead align="left" className="hidden sm:table-cell">
              {t("DashboardIssuance.activity.columnActorType")}
            </TableHead>
            <TableHead align="left">{t("DashboardIssuance.activity.columnStatus")}</TableHead>
            <TableHead align="right" className="hidden sm:table-cell">
              {t("DashboardIssuance.activity.columnTime")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <ActivityEventRow key={event.id} event={event} locale={locale} t={t} />
          ))}
        </TableBody>
      </Table>
      <ArrowPagination
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        disabled={busy}
        summary={t("DashboardIssuance.pagination.range", { start, end, total })}
      />
    </div>
  );
}

export function ActivityTab({ tokenId, isDraft = false }: { tokenId: string; isDraft?: boolean }) {
  const t = useTranslations();
  const [view, setView] = useState(isDraft ? "changes" : "transactions");
  return (
    <div className="space-y-5">
      {!isDraft ? (
        <SegmentedControl
          className="max-w-xs"
          ariaLabel={t("DashboardIssuance.simplified.activityView")}
          options={[
            { value: "transactions", label: t("DashboardIssuance.transactions.title") },
            { value: "changes", label: t("DashboardIssuance.simplified.changes") },
          ]}
          value={view}
          onChange={setView}
        />
      ) : null}
      {view === "transactions" && !isDraft ? (
        <TokenTransactionsBrowser tokenId={tokenId} />
      ) : (
        <AuditActivity tokenId={tokenId} />
      )}
    </div>
  );
}

function AuditActivity({ tokenId }: { tokenId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [action, setAction] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [actorType, setActorType] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, error, isLoading, isValidating } = usePersistedDashboardSWR(
    ["asset-audit", tokenId, action ?? "all", status ?? "all", actorType ?? "all", page] as const,
    ([, id, act, st, ty, pageNumber]) =>
      fetchAssetAuditHistory(id, {
        action: act === "all" ? null : act,
        status: st === "all" ? null : st,
        actorType: ty === "all" ? null : ty,
        page: Number(pageNumber),
        pageSize: PAGE_SIZE,
      }),
    // keepPreviousData → paging/filtering keeps the current rows on screen
    // (dimmed) while the next page loads, instead of flashing the empty state.
    { revalidateOnFocus: true, revalidateIfStale: true, keepPreviousData: true },
    {
      key: `token.${tokenId}.audit.${action ?? "all"}.${status ?? "all"}.${actorType ?? "all"}.${page}`,
      ttlMs: 30_000,
    }
  );

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  // `busy` = any in-flight fetch. With keepPreviousData, isLoading is only true on
  // the first load (no data yet), so isValidating is what catches filter and page
  // changes. The filters + pager are blocked while busy; a refetch over
  // already-shown rows also dims them.
  const busy = isValidating;
  const isInitialLoading = isLoading && events.length === 0;
  const isRefreshing = busy && events.length > 0;
  // A shrinking result set can leave the current page past the end; step back to
  // the last real page instead of an empty list under a "Page 5 of 3" pager.
  const pageCount = getPageCount(total, PAGE_SIZE);
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : t("DashboardIssuance.activity.error")
    : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <h3 className="hidden text-base font-medium text-primary sm:block">
          {t("DashboardIssuance.activity.title")}
        </h3>
        <ActivityFilters
          t={t}
          action={action}
          status={status}
          actorType={actorType}
          busy={busy}
          onActionChange={(value) => {
            setAction(value);
            setPage(1);
          }}
          onStatusChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          onActorTypeChange={(value) => {
            setActorType(value);
            setPage(1);
          }}
        />
      </div>
      <ActivityResults
        t={t}
        locale={locale}
        isInitialLoading={isInitialLoading}
        isRefreshing={isRefreshing}
        busy={busy}
        errorMessage={errorMessage}
        events={events}
        total={total}
        page={page}
        onPageChange={setPage}
      />
    </section>
  );
}
