"use client";

import {
  type ApprovalRequestStatus,
  type WalletApprovalRequestSummary,
  type WalletOperationFamily,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import {
  ArrowLeftRightIcon,
  CalendarIcon,
  ChevronRight,
  CircleDotIcon,
  InboxIcon,
  KeyRoundIcon,
  RotateCw,
  WalletIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { DateRangePicker, formatDateValue } from "@/components/ui/date-picker";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { PaginatedFooter, usePaginationUrlState } from "@/components/ui/paginated-footer";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { cn } from "@/lib/utils";
import { formatDisplayAmount, resolveTokenByMint } from "../payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments/payments-page.data";
import { ApprovalStatusBadge } from "./approval-request-shared";
import {
  APPROVAL_HISTORY_STATUSES,
  APPROVAL_INBOX_PAGE_SIZE,
  APPROVAL_OPERATION_FAMILIES,
  type ApprovalInboxFilters,
  type ApprovalInboxTab,
  approvalApiKeyLabel,
  approvalBadgeStatus,
  approvalReason,
  approvalWalletLabel,
  EMPTY_APPROVAL_FILTERS,
  fetchApprovalRequests,
  filterApprovalRequests,
  formatApprovalLabel,
  formatApprovalRelativeTime,
  hasApprovalFilters,
  shortApprovalIdentifier,
} from "./approval-requests.data";

const AUTO_REFRESH_INTERVAL_MS = 5000;

function approvalRequestHref(approvalRequestId: string): string {
  return `/dashboard/approvals/${encodeURIComponent(approvalRequestId)}`;
}

interface ApprovalInboxProps {
  /**
   * The page's immutable project scope, or null when the page could not
   * resolve one. Refreshes re-bind to it explicitly instead of the shared
   * selection cookie, and responses carrying another project's rows are
   * dropped, so a mounted inbox can never mix projects.
   */
  projectId: string | null;
  initialRequests: WalletApprovalRequestSummary[];
  apiKeyNames: Record<string, string>;
  /** The org's issued tokens keyed by mint, so SDP-minted assets resolve to a symbol. */
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  canDecide: boolean;
  renderedAt: number;
  loadError?: boolean;
}

/**
 * The inbox's data lives under its project scope, so an update is only ever
 * applied when the scope that requested it is still the mounted one.
 */
interface InboxState {
  scope: { projectId: string | null };
  requests: WalletApprovalRequestSummary[];
  relativeTimeBase: number;
  loadError: boolean;
}

/** The wallet and API-key filter options derived from the mounted rows. */
interface ApprovalFilterOptions {
  walletOptions: [string, string][];
  apiKeyOptions: [string, string][];
}

function sortedLabels(entries: Iterable<[string, string]>): [string, string][] {
  return [...entries].sort((left, right) => left[1].localeCompare(right[1]));
}

function approvalFilterOptions(
  requests: WalletApprovalRequestSummary[],
  apiKeyNames: Record<string, string>
): ApprovalFilterOptions {
  const wallets = new Map<string, string>();
  const apiKeys = new Map<string, string>();
  for (const request of requests) {
    wallets.set(request.operation.walletId, approvalWalletLabel(request));
    const apiKeyId = request.operation.apiKeyId;
    if (apiKeyId) apiKeys.set(apiKeyId, apiKeyNames[apiKeyId] || shortApprovalIdentifier(apiKeyId));
  }
  return { walletOptions: sortedLabels(wallets), apiKeyOptions: sortedLabels(apiKeys) };
}

/** The empty-state copy for the active tab, sensitive to active filters. */
function emptyStateKeys(
  tab: ApprovalInboxTab,
  hasFilters: boolean
): {
  title: MessageKey;
  description: MessageKey;
} {
  if (hasFilters) {
    return {
      title: "DashboardApprovals.emptyFiltered",
      description: "DashboardApprovals.emptyFilteredDescription",
    };
  }
  return tab === "pending"
    ? {
        title: "DashboardApprovals.emptyPending",
        description: "DashboardApprovals.emptyPendingDescription",
      }
    : {
        title: "DashboardApprovals.emptyHistory",
        description: "DashboardApprovals.emptyHistoryDescription",
      };
}

/**
 * Drives an inbox's refreshes: manual reloads and the five-second
 * auto-refresh, all pinned to the mounted scope's identity.
 *
 * Every fetch names the mounted project explicitly (`x-project-id`), so the
 * proxy binds the response to this inbox's scope instead of resolving the
 * shared selection cookie, which a sibling tab can change at any moment.
 */
function useInboxRefresh(options: {
  projectId: string | null;
  scope: InboxState["scope"];
  setInbox: Dispatch<SetStateAction<InboxState>>;
  hasRows: boolean;
}) {
  const t = useTranslations();
  const [isReloading, setReloading] = useState(false);
  const [spinning, setSpinning] = useState(false);
  if (isReloading && !spinning) setSpinning(true);

  /**
   * Refetches pending and recent approval requests and merges them into state.
   *
   * @param request - `silent` suppresses the failure toast for background
   * auto-refreshes; manual reloads pass `silent: false` to surface the error.
   */
  async function reload(request: { silent: boolean }) {
    if (isReloading) return;
    // The scope pins this attempt to the mounted project: its identity is
    // what the update below is judged against, so a response that resolves
    // after the project changed never writes into the new scope.
    const scope = options.scope;
    setReloading(true);
    try {
      // `null` only when an unbound batch pair establishes nothing (both
      // batches empty without the explicit binding): an older proxy still
      // resolving the shared cookie can answer like that for a sibling tab's
      // empty project, so the mounted rows stand rather than being erased by
      // an answer that proves nothing. A bound empty pair applies, clearing
      // rows the mounted project genuinely no longer has.
      const merged = await fetchApprovalRequests(options.projectId);
      // Functional so a response that resolves after the scope moved on is
      // dropped rather than written into the new scope's inbox.
      options.setInbox((prev) => {
        if (prev.scope !== scope) return prev;
        const repaint = merged ? { requests: merged, relativeTimeBase: Date.now() } : {};
        return { ...prev, ...repaint, loadError: false };
      });
      if (merged) window.dispatchEvent(new Event("sdp:approval-requests-updated"));
    } catch {
      options.setInbox((prev) => (prev.scope === scope ? { ...prev, loadError: true } : prev));
      if (!request.silent && options.hasRows) {
        toast.error(t("DashboardApprovals.refreshFailed"), { position: "bottom-right" });
      }
    } finally {
      setReloading(false);
    }
  }

  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the timer is deliberately recreated whenever the mounted project changes, so no interval outlives its scope.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void reloadRef.current({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [options.projectId]);

  return {
    isReloading,
    spinning,
    reload,
    // A finished reload stops the spinner at its next full revolution.
    onSpinRest: () => {
      if (!isReloading) setSpinning(false);
    },
  };
}

function ReloadSpinner({ spinning, onRest }: { spinning: boolean; onRest: () => void }) {
  return (
    <RotateCw className={cn("size-4", spinning && "animate-spin")} onAnimationIteration={onRest} />
  );
}

/** The takeover panel shown when the mounted project's initial load failed. */
function InboxLoadErrorPanel({
  isReloading,
  spinning,
  onSpinRest,
  onReload,
}: {
  isReloading: boolean;
  spinning: boolean;
  onSpinRest: () => void;
  onReload: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-[420px] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium text-primary">{t("DashboardApprovals.unableToLoad")}</h1>
        <p className="mt-2 text-sm text-secondary">
          {t("DashboardApprovals.unableToLoadDescription")}
        </p>
        <Button
          className="mt-5"
          variant="outline"
          onClick={onReload}
          disabled={isReloading}
          iconLeft={<ReloadSpinner spinning={spinning} onRest={onSpinRest} />}
        >
          {t("DashboardApprovals.reload")}
        </Button>
      </div>
    </div>
  );
}

function InboxFooter({
  total,
  rangeStart,
  rangeEnd,
  pendingCount,
  page,
  pageCount,
  onPageChange,
  pageSize,
  onPageSizeChange,
  onReload,
  isReloading,
  spinning,
  onSpinRest,
}: {
  total: number;
  rangeStart: number;
  rangeEnd: number;
  pendingCount: number;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  onReload: () => void;
  isReloading: boolean;
  spinning: boolean;
  onSpinRest: () => void;
}) {
  const t = useTranslations();
  if (total === 0) return null;
  return (
    <PaginatedFooter
      className="mt-auto"
      page={page}
      pageCount={pageCount}
      onPageChange={onPageChange}
      summary={t("DashboardApprovals.range", { from: rangeStart, to: rangeEnd, total })}
      pageSizeControl={{ pageSize, onPageSizeChange }}
    >
      <div className="flex items-center gap-2 text-xs text-secondary">
        <span>{t("DashboardApprovals.pendingCount", { count: pendingCount })}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onReload}
              disabled={isReloading}
              aria-label={t("DashboardApprovals.reload")}
            >
              <ReloadSpinner spinning={spinning} onRest={onSpinRest} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {t("DashboardApprovals.autoRefresh")}
          </TooltipContent>
        </Tooltip>
      </div>
    </PaginatedFooter>
  );
}

export function ApprovalInbox({
  projectId,
  initialRequests,
  apiKeyNames,
  issuedTokensByMint,
  canDecide,
  renderedAt,
  loadError = false,
}: ApprovalInboxProps) {
  const t = useTranslations();
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const tab: ApprovalInboxTab = useDashboardTab() === "history" ? "history" : "pending";
  const { page, pageSize, setPage, setPageSize } = usePaginationUrlState(APPROVAL_INBOX_PAGE_SIZE);
  // Rows and their project scope move together, so a refresh answered for
  // another project is dropped whole instead of partially applied.
  const [inbox, setInbox] = useState<InboxState>(() => ({
    scope: { projectId },
    requests: initialRequests,
    relativeTimeBase: renderedAt,
    loadError,
  }));
  const { requests, relativeTimeBase, loadError: hasLoadError } = inbox;
  const [filters, setFilters] = useState<ApprovalInboxFilters>(EMPTY_APPROVAL_FILTERS);
  const { isReloading, spinning, reload, onSpinRest } = useInboxRefresh({
    projectId,
    scope: inbox.scope,
    setInbox,
    hasRows: requests.length > 0,
  });
  const [previousTab, setPreviousTab] = useState(tab);
  if (previousTab !== tab) {
    setPreviousTab(tab);
    setFilters(EMPTY_APPROVAL_FILTERS);
  }
  // The mounted project is the inbox's identity: when it changes, rows,
  // filters and load state reset to the new scope's initial data, and every
  // in-flight refresh of the old scope is dropped by its scope identity.
  if (inbox.scope.projectId !== projectId) {
    setInbox({
      scope: { projectId },
      requests: initialRequests,
      relativeTimeBase: renderedAt,
      // The new scope's page props carry its own load state, so a project
      // whose initial load failed shows the error panel, not an empty inbox.
      loadError,
    });
    setFilters(EMPTY_APPROVAL_FILTERS);
  }

  const { walletOptions, apiKeyOptions } = useMemo(
    () => approvalFilterOptions(requests, apiKeyNames),
    [apiKeyNames, requests]
  );
  const filteredRequests = useMemo(
    () => filterApprovalRequests(requests, tab, filters),
    [filters, requests, tab]
  );
  const pendingCount = useMemo(
    () => requests.filter((request) => request.status === "pending").length,
    [requests]
  );
  const pageCount = Math.max(1, Math.ceil(filteredRequests.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRequests = filteredRequests.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );
  const rangeStart = filteredRequests.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, filteredRequests.length);

  function updateFilter<TKey extends keyof ApprovalInboxFilters>(
    key: TKey,
    value: ApprovalInboxFilters[TKey]
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function patchFilters(patch: Partial<ApprovalInboxFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  if (hasLoadError && requests.length === 0) {
    return (
      <InboxLoadErrorPanel
        isReloading={isReloading}
        spinning={spinning}
        onSpinRest={onSpinRest}
        onReload={() => reload({ silent: false })}
      />
    );
  }

  const emptyState = emptyStateKeys(tab, hasApprovalFilters(filters));

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col">
      <DashboardWorkspaceCard>
        {!canDecide ? (
          <p className="border-b border-border-default bg-fill-subtle px-4 py-2 text-sm text-secondary">
            {t("DashboardApprovals.viewOnly")}
          </p>
        ) : null}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            className="flex min-w-0 flex-1 flex-col"
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
              patchFilters={patchFilters}
            />

            {visibleRequests.length === 0 ? (
              <ListEmptyState
                icon={<InboxIcon className="size-5" />}
                message={t(emptyState.title)}
                description={t(emptyState.description)}
              />
            ) : (
              <ApprovalRequestRows
                requests={visibleRequests}
                apiKeyNames={apiKeyNames}
                issuedTokensByMint={issuedTokensByMint}
                locale={locale}
                relativeTimeBase={relativeTimeBase}
              />
            )}
          </motion.div>
        </AnimatePresence>

        <InboxFooter
          total={filteredRequests.length}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          pendingCount={pendingCount}
          page={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          onReload={() => reload({ silent: false })}
          isReloading={isReloading}
          spinning={spinning}
          onSpinRest={onSpinRest}
        />
      </DashboardWorkspaceCard>
    </DashboardWorkspaceOverviewPanel>
  );
}

function ApprovalFilters({
  tab,
  filters,
  walletOptions,
  apiKeyOptions,
  updateFilter,
  patchFilters,
}: {
  tab: ApprovalInboxTab;
  filters: ApprovalInboxFilters;
  walletOptions: [string, string][];
  apiKeyOptions: [string, string][];
  updateFilter: <TKey extends keyof ApprovalInboxFilters>(
    key: TKey,
    value: ApprovalInboxFilters[TKey]
  ) => void;
  patchFilters: (patch: Partial<ApprovalInboxFilters>) => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-border-default p-3">
      <FilterField className="min-w-44 flex-1" label={t("DashboardApprovals.walletFilter")}>
        <Select
          ariaLabel={t("DashboardApprovals.walletFilter")}
          size="xl"
          iconLeft={<WalletIcon />}
          value={filters.walletId || "all"}
          onValueChange={(value) => updateFilter("walletId", value === "all" ? "" : (value ?? ""))}
        >
          <SelectItem value="all">{t("DashboardApprovals.allWallets")}</SelectItem>
          {walletOptions.map(([walletId, label]) => (
            <SelectItem key={walletId} value={walletId}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      {tab === "history" ? (
        <FilterField className="min-w-44 flex-1" label={t("DashboardApprovals.statusFilter")}>
          <Select
            ariaLabel={t("DashboardApprovals.statusFilter")}
            size="xl"
            iconLeft={<CircleDotIcon />}
            value={filters.status || "all"}
            onValueChange={(value) =>
              updateFilter("status", value === "all" ? "" : (value as ApprovalRequestStatus))
            }
          >
            <SelectItem value="all">{t("DashboardApprovals.allStatuses")}</SelectItem>
            {APPROVAL_HISTORY_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {formatApprovalLabel(status)}
              </SelectItem>
            ))}
          </Select>
        </FilterField>
      ) : null}

      <FilterField className="min-w-44 flex-1" label={t("DashboardApprovals.operationFilter")}>
        <Select
          ariaLabel={t("DashboardApprovals.operationFilter")}
          size="xl"
          iconLeft={<ArrowLeftRightIcon />}
          value={filters.operationFamily || "all"}
          onValueChange={(value) =>
            updateFilter("operationFamily", value === "all" ? "" : (value as WalletOperationFamily))
          }
        >
          <SelectItem value="all">{t("DashboardApprovals.allOperations")}</SelectItem>
          {APPROVAL_OPERATION_FAMILIES.map((family) => (
            <SelectItem key={family} value={family}>
              {formatApprovalLabel(family)}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      <FilterField className="min-w-44 flex-1" label={t("DashboardApprovals.apiKeyFilter")}>
        <Select
          ariaLabel={t("DashboardApprovals.apiKeyFilter")}
          size="xl"
          iconLeft={<KeyRoundIcon />}
          value={filters.apiKeyId || "all"}
          onValueChange={(value) => updateFilter("apiKeyId", value === "all" ? "" : (value ?? ""))}
        >
          <SelectItem value="all">{t("DashboardApprovals.allApiKeys")}</SelectItem>
          {apiKeyOptions.map(([apiKeyId, label]) => (
            <SelectItem key={apiKeyId} value={apiKeyId}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </FilterField>

      <DateRangeFilter
        from={filters.from}
        to={filters.to}
        onChange={(from, to) => patchFilters({ from, to })}
      />
    </div>
  );
}

const DATE_PRESETS = [7, 30, 90] as const;
type DatePreset = "all" | "7" | "30" | "90" | "custom";

function presetRange(days: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return { from: formatDateValue(start), to: formatDateValue(now) };
}

function activeDatePreset(from: string, to: string): DatePreset {
  if (!from && !to) return "all";
  for (const days of DATE_PRESETS) {
    const range = presetRange(days);
    if (range.from === from && range.to === to) return `${days}` as DatePreset;
  }
  return "custom";
}

function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const t = useTranslations();
  const derived = activeDatePreset(from, to);
  const [customOpen, setCustomOpen] = useState(derived === "custom");
  // An external reset (Clear filters, tab switch) collapses the custom fields.
  useEffect(() => {
    if (derived !== "custom") setCustomOpen(false);
  }, [derived]);
  const showCustom = customOpen || derived === "custom";
  const active: DatePreset = showCustom ? "custom" : derived;

  function selectPreset(preset: DatePreset) {
    if (preset === "all") {
      setCustomOpen(false);
      onChange("", "");
      return;
    }
    if (preset === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    const range = presetRange(Number(preset));
    onChange(range.from, range.to);
  }

  return (
    <>
      <FilterField className="min-w-44 flex-1" label={t("DashboardApprovals.dateRangeLabel")}>
        <Select
          ariaLabel={t("DashboardApprovals.dateRangeLabel")}
          size="xl"
          iconLeft={<CalendarIcon />}
          value={active}
          onValueChange={(value) => selectPreset(value as DatePreset)}
        >
          <SelectItem value="all">{t("DashboardApprovals.dateAllTime")}</SelectItem>
          <SelectItem value="7">{t("DashboardApprovals.dateLast7")}</SelectItem>
          <SelectItem value="30">{t("DashboardApprovals.dateLast30")}</SelectItem>
          <SelectItem value="90">{t("DashboardApprovals.dateLast90")}</SelectItem>
          <SelectItem value="custom">{t("DashboardApprovals.dateCustom")}</SelectItem>
        </Select>
      </FilterField>
      {showCustom ? (
        <FilterField
          className="min-w-72 flex-[2] sm:min-w-[22rem]"
          label={t("DashboardApprovals.dateCustom")}
        >
          <DateRangePicker
            size="xl"
            from={from}
            to={to}
            onChange={onChange}
            ariaLabel={`${t("DashboardApprovals.fromFilter")} – ${t("DashboardApprovals.toFilter")}`}
          />
        </FilterField>
      ) : null}
    </>
  );
}

function FilterField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={cn("space-y-1.5", className)}>
      <legend className="block text-xs font-medium text-secondary">{label}</legend>
      {children}
    </fieldset>
  );
}

function ApprovalRequestRows({
  requests,
  apiKeyNames,
  issuedTokensByMint,
  locale,
  relativeTimeBase,
}: {
  requests: WalletApprovalRequestSummary[];
  apiKeyNames: Record<string, string>;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
  relativeTimeBase: number;
}) {
  const t = useTranslations();
  return (
    <>
      <div className="divide-y divide-border-default lg:hidden">
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
              className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 p-4 outline-none transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ApprovalStatusBadge status={approvalBadgeStatus(request)} />
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
                    value={approvalAmountLabel(request, issuedTokensByMint, locale)}
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

      <div className="hidden lg:block">
        <Table className="min-w-0 rounded-none border-0 [&_table]:min-w-[1178px] [&_table]:table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[148px]">{t("DashboardApprovals.statusColumn")}</TableHead>
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
                    <ApprovalStatusBadge status={approvalBadgeStatus(request)} />
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
                  <ApprovalCell>
                    <ApprovalAmountAsset
                      request={request}
                      issuedTokensByMint={issuedTokensByMint}
                      locale={locale}
                    />
                  </ApprovalCell>
                  <ApprovalCell>
                    <span
                      className="whitespace-nowrap"
                      title={request.operation.destination ?? undefined}
                    >
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

/**
 * Formats an operation's amount and asset for display. The `asset` field holds
 * a mint address, so it resolves through the shared token helpers — the
 * well-known catalogue, then the org's issued tokens — before falling back to
 * a shortened mint, exactly like the transactions tables.
 */
function approvalAmountLabel(
  request: WalletApprovalRequestSummary,
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>,
  locale: string
): string {
  const { amount, asset } = request.operation;
  const tokenName = asset ? resolveTokenByMint(asset, issuedTokensByMint).tokenName : undefined;
  if (!amount) return tokenName ?? "-";
  return formatDisplayAmount(amount, tokenName, locale);
}

/**
 * Operation payloads carry platform token keys ("USDC") for rail-native
 * assets rather than mints. Those keys come from our own API, not issuer
 * metadata, so resolving them to the registry mint does not open the
 * spoofed-symbol hole TokenMark guards against; either cluster's mint maps
 * to the same registry entry, so the mainnet address suffices for the mark.
 */
function wellKnownMintForAssetKey(asset: string): string | null {
  const entry = WELL_KNOWN_TOKENS[asset.trim().toUpperCase() as keyof typeof WELL_KNOWN_TOKENS];
  return entry ? entry.mints["mainnet-beta"].address : null;
}

function ApprovalAmountAsset({
  request,
  issuedTokensByMint,
  locale,
}: {
  request: WalletApprovalRequestSummary;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
}) {
  const asset = request.operation.asset;
  const label = approvalAmountLabel(request, issuedTokensByMint, locale);
  if (!asset) return label;
  const resolvedToken = resolveTokenByMint(asset, issuedTokensByMint);
  return (
    <span className="flex min-w-0 items-center gap-2" title={asset}>
      <TokenMark
        mint={wellKnownMintForAssetKey(asset) ?? resolvedToken.mint}
        symbol={resolvedToken.tokenName}
        logoUrl={resolvedToken.metadataImageUrl}
        size="xs"
      />
      <span className="truncate">{label}</span>
    </span>
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
