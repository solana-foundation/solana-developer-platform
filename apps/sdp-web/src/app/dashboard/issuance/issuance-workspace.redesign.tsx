"use client";

import { XIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions, type FilterMenuSection } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusText } from "@/components/ui/status-text";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type {
  IssuanceDateFilter,
  IssuanceListQuery,
  IssuanceSortOption,
  IssuanceStatusFilter,
} from "./issuance-list-query";
import { IssuanceListRowsSkeleton } from "./issuance-route-skeletons.redesign";
import { getTokenTypeLabel, type IssuanceTokenView } from "./issuance-token-fields";
import {
  type DeployAttemptStatus,
  formatTokenDay,
  TOKEN_LIFECYCLE_LABEL,
  TOKEN_LIFECYCLE_TONE,
  tokenLifecycle,
} from "./issuance-token-state.redesign";
import type { IssuanceTokenFacets } from "./issuance-tokens.data";
import { IssuedTokenMark } from "./issued-token-mark.redesign";
import { LocalDraftsBlock } from "./local-drafts-block.redesign";
import { useIssuancePlaygroundTokens, useIssuanceTokenList } from "./use-issuance-token-list";
import { useLatestDeploys } from "./use-latest-deploys.redesign";

export const ISSUANCE_CREATE_PATH = "/dashboard/issuance/create";

const IssuancePlayground = dynamic(
  () => import("./issuance-playground").then((module) => module.IssuancePlayground),
  { loading: () => <ApiPlaygroundShellSkeleton /> }
);

// Multiples of the list's default page (24), so an untouched list keeps its clean URL.
const ISSUANCE_PAGE_SIZES = [12, 24, 48, 96] as const;

const STATUS_OPTIONS: { value: Exclude<IssuanceStatusFilter, "all">; label: MessageKey }[] = [
  { value: "draft", label: "DashboardIssuance.newDesign.state.draft" },
  { value: "active", label: "DashboardIssuance.newDesign.state.live" },
  { value: "paused", label: "DashboardIssuance.newDesign.state.paused" },
];

const DATE_OPTIONS: { value: Exclude<IssuanceDateFilter, "all">; label: MessageKey }[] = [
  { value: "7d", label: "DashboardIssuance.newDesign.list.last7Days" },
  { value: "30d", label: "DashboardIssuance.newDesign.list.last30Days" },
  { value: "12m", label: "DashboardIssuance.newDesign.list.last12Months" },
];

const SORT_OPTIONS: { value: IssuanceSortOption; label: MessageKey }[] = [
  { value: "newest", label: "DashboardIssuance.newDesign.list.sortNewest" },
  { value: "oldest", label: "DashboardIssuance.newDesign.list.sortOldest" },
  { value: "name-asc", label: "DashboardIssuance.newDesign.list.sortNameAsc" },
  { value: "name-desc", label: "DashboardIssuance.newDesign.list.sortNameDesc" },
];

interface IssuanceApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface IssuanceTemplateOption {
  id: string;
  name: string;
  description?: string;
}

export interface IssuanceWorkspaceProps {
  initialQuery: IssuanceListQuery;
  initialTokens: IssuanceTokenView[];
  initialTotal: number;
  facets: IssuanceTokenFacets;
  templates: IssuanceTemplateOption[];
  apiKeys: IssuanceApiKeyOption[];
  apiBaseUrl: string | null;
  templatesError: string | null;
  tokensNotice: string | null;
}

/**
 * Issuance as the design lays it out: Overview, the project's tokens one per row with their
 * state and the date that matters, and the API Playground beside it in the header's tabs.
 */
export function IssuanceWorkspace(props: IssuanceWorkspaceProps) {
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const { apiKeys } = props;
  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);
  const isPlaygroundTab = issuanceTab === "playground";
  const playgroundTokens = useIssuancePlaygroundTokens(isPlaygroundTab) ?? props.initialTokens;
  const playgroundApiKeyId = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId)?.id ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );

  return (
    <DashboardWorkspaceTabShell
      panels={[
        {
          id: "overview",
          className: dashboardWorkspaceOverviewPanelClassName,
          content: (
            <div className="flex flex-col gap-8">
              <LocalDraftsBlock />
              <IssuanceTokenList {...props} />
            </div>
          ),
        },
        {
          id: "playground",
          className: dashboardWorkspacePlaygroundPanelClassName,
          content: (
            <IssuancePlayground
              apiBaseUrl={props.apiBaseUrl}
              apiKeyId={playgroundApiKeyId}
              hasActiveApiKeys={apiKeys.length > 0}
              templates={props.templates}
              templatesError={props.templatesError}
              tokens={playgroundTokens}
            />
          ),
        },
      ]}
    />
  );
}

function IssuanceTokenList({
  initialQuery,
  initialTokens,
  initialTotal,
  facets,
  tokensNotice,
}: IssuanceWorkspaceProps) {
  const t = useTranslations();
  const {
    query,
    search,
    setSearch,
    updateQuery,
    clearFilters,
    tokens,
    total,
    pageCount,
    rangeStart,
    rangeEnd,
    isFiltered,
    isRefreshing,
    isLoadingNewResults,
    isLoadingAnotherPage,
    errorMessage,
  } = useIssuanceTokenList({ initialQuery, initialTokens, initialTotal });
  const { sections, chips } = useIssuanceFilterSections(query, updateQuery, facets);
  const latestDeploys = useLatestDeploys(tokens);
  const searchOnly = Boolean(query.search) && chips.length === 0;

  // The project's own count, not the filtered page's: what tells "no tokens yet" from
  // "nothing matches".
  if (facets.total === 0 && !isFiltered && tokens.length === 0) {
    return tokensNotice ? (
      <ListEmptyState
        message={t("DashboardIssuance.newDesign.list.loadFailed")}
        description={tokensNotice}
      />
    ) : (
      <ListEmptyState
        message={t("DashboardIssuance.newDesign.list.emptyTitle")}
        description={t("DashboardIssuance.newDesign.list.emptyBody")}
        hidesPageAction
        action={
          <Button asChild>
            <Link href={ISSUANCE_CREATE_PATH}>{t("DashboardIssuance.newDesign.createDraft")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5" aria-busy={isRefreshing}>
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={sections}
          />
        }
      >
        <Select
          ariaLabel={t("DashboardIssuance.newDesign.list.sort")}
          value={query.sort}
          onValueChange={(value) => {
            const sort = SORT_OPTIONS.find((option) => option.value === value)?.value;
            if (sort) updateQuery({ sort });
          }}
          className="hidden w-auto shrink-0 sm:flex"
          textSize="body"
        >
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.label)}
            </SelectItem>
          ))}
        </Select>
        <RowsPerPageSelect
          value={query.pageSize}
          sizes={ISSUANCE_PAGE_SIZES}
          onChange={(pageSize) => updateQuery({ pageSize })}
        />
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          clear={{
            label: t("DashboardIssuance.newDesign.list.clearSearch"),
            onClear: () => setSearch(""),
          }}
          placeholder={t("DashboardIssuance.newDesign.list.searchPlaceholder")}
          aria-label={t("DashboardIssuance.newDesign.list.searchLabel")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      <FilterChips chips={chips} />
      {errorMessage ? (
        <ListEmptyState
          message={t("DashboardIssuance.newDesign.list.loadFailed")}
          description={t("DashboardIssuance.errors.unableToLoadTokens")}
        />
      ) : isLoadingNewResults ? (
        <IssuanceListRowsSkeleton />
      ) : tokens.length === 0 ? (
        <NoMatches
          search={searchOnly ? query.search : null}
          total={facets.total}
          onClear={clearFilters}
        />
      ) : (
        <>
          <ul
            className={cn(
              "flex flex-col transition-opacity",
              isLoadingAnotherPage ? "opacity-60" : null
            )}
          >
            {tokens.map((token) => (
              <li key={token.id}>
                <IssuanceTokenRow token={token} latestDeploy={latestDeploys[token.id]} />
              </li>
            ))}
          </ul>
          {pageCount > 1 ? (
            <ArrowPagination
              page={query.page}
              pageCount={pageCount}
              onPageChange={(page) => updateQuery({ page })}
              summary={t("DashboardIssuance.pagination.range", {
                start: rangeStart,
                end: rangeEnd,
                total,
              })}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

interface FilterChip {
  id: string;
  label: string;
  value: string;
  clear: () => void;
}

/** The Filter menu's three axes, Status, Template and Created, and a chip for each one set. */
function useIssuanceFilterSections(
  query: IssuanceListQuery,
  updateQuery: (changes: Partial<IssuanceListQuery>) => void,
  facets: IssuanceTokenFacets
): { sections: FilterMenuSection[]; chips: FilterChip[] } {
  const t = useTranslations();
  const anyLabel = t("Shared.SharedComponents.any");
  const templateOptions = facets.templates
    .map(({ template }) => ({ value: template, label: getTokenTypeLabel(template, t) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const statusLabel = STATUS_OPTIONS.find((option) => option.value === query.status)?.label;
  const dateLabel = DATE_OPTIONS.find((option) => option.value === query.date)?.label;
  const templateLabel =
    query.template === "all"
      ? undefined
      : (templateOptions.find((option) => option.value === query.template)?.label ??
        query.template);
  const sections: (FilterMenuSection & { reset: Partial<IssuanceListQuery> })[] = [
    {
      id: "status",
      label: t("DashboardIssuance.newDesign.list.filterStatus"),
      value: statusLabel ? t(statusLabel) : undefined,
      reset: { status: "all" },
      content: (
        <FilterMenuOptions
          value={query.status === "all" ? undefined : query.status}
          anyLabel={anyLabel}
          options={STATUS_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={(value) =>
            updateQuery({
              status: STATUS_OPTIONS.find((option) => option.value === value)?.value ?? "all",
            })
          }
        />
      ),
    },
    {
      id: "template",
      label: t("DashboardIssuance.newDesign.list.filterTemplate"),
      value: templateLabel,
      reset: { template: "all" },
      content: (
        <FilterMenuOptions
          value={query.template === "all" ? undefined : query.template}
          anyLabel={anyLabel}
          options={templateOptions}
          onChange={(value) => updateQuery({ template: value ?? "all" })}
        />
      ),
    },
    {
      id: "date",
      label: t("DashboardIssuance.newDesign.list.filterCreated"),
      value: dateLabel ? t(dateLabel) : undefined,
      reset: { date: "all" },
      content: (
        <FilterMenuOptions
          value={query.date === "all" ? undefined : query.date}
          anyLabel={anyLabel}
          options={DATE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
          onChange={(value) =>
            updateQuery({
              date: DATE_OPTIONS.find((option) => option.value === value)?.value ?? "all",
            })
          }
        />
      ),
    },
  ];
  const chips = sections.flatMap((section) =>
    section.value === undefined
      ? []
      : [
          {
            id: section.id,
            label: section.label,
            value: section.value,
            clear: () => updateQuery(section.reset),
          },
        ]
  );
  return { sections, chips };
}

/** No row answers the search, or the filters. */
function NoMatches({
  search,
  total,
  onClear,
}: {
  search: string | null;
  total: number;
  onClear: () => void;
}) {
  const t = useTranslations();
  return (
    <ListEmptyState
      message={
        search
          ? t("DashboardIssuance.newDesign.list.noSearchMatchTitle", { search })
          : t("DashboardIssuance.newDesign.list.noFilterMatchTitle")
      }
      description={
        search
          ? t("DashboardIssuance.newDesign.list.noSearchMatchBody", { count: total })
          : t("DashboardIssuance.newDesign.list.noFilterMatchBody")
      }
      action={
        <Button variant="secondary" onClick={onClear}>
          {search
            ? t("DashboardIssuance.newDesign.list.clearSearch")
            : t("DashboardIssuance.newDesign.list.clearAll")}
        </Button>
      }
    />
  );
}

/** The filters in force, each with a button that clears it. */
function FilterChips({ chips }: { chips: readonly FilterChip[] }) {
  const t = useTranslations();
  if (chips.length === 0) return null;
  return (
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
            onClick={chip.clear}
            className="rounded-control-inner p-0.5 text-tertiary hover:bg-fill hover:text-primary"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * One token: its mark, name and ticker over its state, and on the right when it went on
 * chain, or when it was drafted while it has not.
 */
function IssuanceTokenRow({
  token,
  latestDeploy,
}: {
  token: IssuanceTokenView;
  latestDeploy?: DeployAttemptStatus | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const state = tokenLifecycle(token, latestDeploy);
  const deployed = Boolean(token.deployedAt);
  // A ticker that only repeats the name adds nothing beside it.
  const ticker = token.symbol.toLowerCase() === token.name.toLowerCase() ? "" : token.symbol;

  return (
    <Link
      href={`/dashboard/issuance/${token.id}`}
      data-issuance-token-row={token.id}
      className="-mx-2 grid grid-cols-[36px_minmax(0,1fr)_max-content] items-center gap-x-3 rounded-control border-b border-border-subtle px-2 py-4 outline-none hover:bg-fill-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
    >
      <IssuedTokenMark symbol={token.symbol} name={token.name} logoUrl={token.imageUrl} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-body font-medium text-primary">{token.name}</span>
          {ticker ? (
            <span className="text-meta tracking-wide text-tertiary uppercase">{ticker}</span>
          ) : null}
        </span>
        <StatusText tone={TOKEN_LIFECYCLE_TONE[state]} className="text-meta">
          {t(TOKEN_LIFECYCLE_LABEL[state])}
        </StatusText>
      </span>
      <span className="flex flex-col items-end gap-1 text-right">
        <span className="text-meta text-tertiary">
          {t(
            deployed
              ? "DashboardIssuance.newDesign.list.deployed"
              : "DashboardIssuance.newDesign.list.created"
          )}
        </span>
        <span className="text-body text-primary tabular-nums">
          {formatTokenDay(deployed ? token.deployedAt : token.createdAt, locale) ?? "—"}
        </span>
      </span>
    </Link>
  );
}
