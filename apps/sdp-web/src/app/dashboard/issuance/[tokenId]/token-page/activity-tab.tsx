"use client";

import type { Token } from "@sdp/types";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "@/app/dashboard/payments/payments-table";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions, type FilterMenuSection } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar } from "@/components/ui/list-toolbar";
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
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  ACTIVITY_ACTIONS,
  activityActorType,
  activityEventLabel,
  activitySignature,
  activityStatus,
  useTokenActivity,
} from "./token-activity";
import { transactionExplorerHref } from "./token-page.shared";

// The history is read in one window and searched and paged here: the audit API filters by
// event, actor type and status but has no text search.
const WINDOW = 100;
const PAGE_SIZE = 25;
const ACTOR_TYPES = ["user", "api_key", "system"] as const;
const STATUSES = ["success", "failure"] as const;

interface ActivityFilters {
  action?: string;
  actorType?: string;
  status?: string;
}

/** Everything done to the token, by whom, how it went and when, newest first. */
export function TokenActivityTab({ token }: { token: Token }) {
  const t = useTranslations();
  const locale = useLocale();
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { data, error } = useTokenActivity(token.id, { page: 1, pageSize: WINDOW, ...filters });
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    [locale]
  );

  const needle = search.trim().toLowerCase();
  const events = (data?.events ?? []).filter((event) =>
    needle
      ? [activityEventLabel(event.action, t), event.actorLabel, activityStatus(event, t).label]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      : true
  );
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const visible = events.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const update = (changes: ActivityFilters) => {
    setFilters((current) => ({ ...current, ...changes }));
    setPage(1);
  };

  const anyLabel = t("Shared.SharedComponents.any");
  const actorLabel = (value: string) => activityActorType({ actorType: value as "user" }, t);
  const statusLabel = (value: string) => activityStatus({ status: value as "success" }, t).label;
  const sections: FilterMenuSection[] = [
    {
      id: "action",
      label: t("DashboardIssuance.newDesign.activity.event"),
      value: filters.action ? activityEventLabel(filters.action, t) : undefined,
      content: (
        <FilterMenuOptions
          value={filters.action}
          anyLabel={anyLabel}
          options={ACTIVITY_ACTIONS.map((action) => ({
            value: action,
            label: activityEventLabel(action, t),
          }))}
          onChange={(action) => update({ action })}
        />
      ),
    },
    {
      id: "actorType",
      label: t("DashboardIssuance.newDesign.activity.actorType"),
      value: filters.actorType ? actorLabel(filters.actorType) : undefined,
      content: (
        <FilterMenuOptions
          value={filters.actorType}
          anyLabel={anyLabel}
          options={ACTOR_TYPES.map((value) => ({ value, label: actorLabel(value) }))}
          onChange={(actorType) => update({ actorType })}
        />
      ),
    },
    {
      id: "status",
      label: t("DashboardIssuance.newDesign.activity.status"),
      value: filters.status ? statusLabel(filters.status) : undefined,
      content: (
        <FilterMenuOptions
          value={filters.status}
          anyLabel={anyLabel}
          options={STATUSES.map((value) => ({ value, label: statusLabel(value) }))}
          onChange={(status) => update({ status })}
        />
      ),
    },
  ];
  const chips = sections.filter((section) => section.value !== undefined);

  return (
    <div className="flex flex-col gap-5">
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={sections}
          />
        }
      >
        <SearchInput
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          clear={{
            label: t("DashboardIssuance.newDesign.list.clearSearch"),
            onClear: () => setSearch(""),
          }}
          placeholder={t("DashboardIssuance.newDesign.activity.searchPlaceholder")}
          aria-label={t("DashboardIssuance.newDesign.activity.searchPlaceholder")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex h-7 items-center gap-1.5 rounded-control bg-fill-subtle pr-1 pl-2.5 text-meta text-secondary"
            >
              {chip.label}: <span className="text-primary">{chip.value}</span>
              <button
                type="button"
                aria-label={t("Shared.SharedComponents.clearFilter", { filter: chip.label })}
                onClick={() => update({ [chip.id]: undefined })}
                className="rounded-control-inner p-0.5 text-tertiary hover:bg-fill hover:text-primary"
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? (
        <ListEmptyState message={t("DashboardIssuance.newDesign.activity.loadFailed")} />
      ) : data && events.length === 0 ? (
        chips.length > 0 || needle ? (
          <ListEmptyState
            message={t("DashboardIssuance.newDesign.activity.noMatchTitle")}
            description={t("DashboardIssuance.newDesign.activity.noMatchBody")}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFilters({});
                  setSearch("");
                }}
              >
                {t("DashboardIssuance.newDesign.list.clearAll")}
              </Button>
            }
          />
        ) : (
          <ListEmptyState message={t("DashboardIssuance.newDesign.activity.empty")} />
        )
      ) : (
        <div className="overflow-x-auto refresh:-mx-3">
          <Table className="min-w-[640px] table-fixed rounded-none border-0">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[24%]" />
              <col className="w-[14%]" />
              <col className="w-[22%]" />
              <col className="w-[10%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.activity.event")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.activity.actor")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.activity.status")}
                </TableHead>
                <TableHead className={PAYMENTS_TABLE_HEAD}>
                  {t("DashboardIssuance.newDesign.activity.when")}
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    {t("DashboardIssuance.newDesign.overview.explorer")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((event) => {
                const status = activityStatus(event, t);
                const signature = activitySignature(event);
                return (
                  <TableRow key={event.id}>
                    <TableCell
                      className={`${PAYMENTS_TABLE_CELL} truncate font-medium text-primary`}
                    >
                      {activityEventLabel(event.action, t)}
                    </TableCell>
                    <TableCell className={`${PAYMENTS_TABLE_CELL} truncate text-primary`}>
                      {event.actorLabel}
                    </TableCell>
                    <TableCell className={PAYMENTS_TABLE_CELL}>
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                    </TableCell>
                    <TableCell className={`${PAYMENTS_TABLE_CELL} text-primary tabular-nums`}>
                      {formatter.format(new Date(event.createdAt))}
                    </TableCell>
                    <TableCell className={PAYMENTS_TABLE_CELL}>
                      {signature ? (
                        <a
                          href={transactionExplorerHref(signature)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-secondary hover:text-primary"
                        >
                          {t("DashboardIssuance.newDesign.overview.explorer")}
                          <ExternalLinkIcon className="size-3" aria-hidden="true" />
                        </a>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {pageCount > 1 ? (
        <ArrowPagination page={page} pageCount={pageCount} onPageChange={setPage} />
      ) : null}
      {data?.hasMore ? (
        <p className="text-meta text-tertiary">
          {t("DashboardIssuance.newDesign.activity.windowNote", { count: WINDOW })}
        </p>
      ) : null}
    </div>
  );
}
