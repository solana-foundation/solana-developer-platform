"use client";

import type {
  PolicyControlInventoryItem,
  PolicyControlInventoryResponse,
  PolicyControlInventoryStatus,
  PolicyDefaultAction,
} from "@sdp/types";
import {
  ChevronDownIcon,
  EllipsisIcon,
  KeyRoundIcon,
  SearchIcon,
  ShieldCheckIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
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
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { readDashboardTabFromUrl, useDashboardTab } from "@/lib/dashboard-url-state";
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";

const POLICIES_TABS = ["all", "wallets", "api_keys"] as const;

export type PoliciesTab = (typeof POLICIES_TABS)[number];

/**
 * Narrows a raw `?tab=` search-param value to a policies tab.
 *
 * @param value - The raw param value, if any.
 * @returns The matching tab, or "all" for missing or unknown values.
 */
function parsePoliciesTab(value: string | null): PoliciesTab {
  return value === "wallets" || value === "api_keys" ? value : "all";
}

export interface PoliciesUrlState {
  tab: PoliciesTab;
  query: string;
  status: PolicyControlInventoryStatus | "";
  page: number;
  pageSize: number;
}

interface PoliciesOverviewProps {
  inventory: PolicyControlInventoryResponse | null;
  error: boolean;
  state: PoliciesUrlState;
}

interface PoliciesOverviewSurfaceProps extends PoliciesOverviewProps {
  loading?: boolean;
  searchValue: string;
  onSearchChange?: (value: string) => void;
  onStateChange?: (changes: Partial<PoliciesUrlState>) => void;
  onRetry?: () => void;
}

const STATUS_OPTIONS: Array<{
  id: PolicyControlInventoryStatus | "all";
  labelKey: MessageKey;
}> = [
  { id: "all", labelKey: "DashboardPolicies.allStatuses" },
  { id: "default_allow", labelKey: "DashboardPolicies.defaultAllow" },
  { id: "draft", labelKey: "DashboardPolicies.draft" },
  { id: "active", labelKey: "DashboardPolicies.active" },
  { id: "disabled", labelKey: "DashboardPolicies.disabled" },
];

const STATUS_LABEL_KEYS = {
  default_allow: "DashboardPolicies.defaultAllow",
  draft: "DashboardPolicies.draft",
  active: "DashboardPolicies.active",
  disabled: "DashboardPolicies.disabled",
} as const satisfies Record<PolicyControlInventoryStatus, MessageKey>;

const DEFAULT_ACTION_LABEL_KEYS = {
  allow: "DashboardPolicies.allow",
  deny: "DashboardPolicies.deny",
  approval_required: "DashboardPolicies.approvalRequired",
  review: "DashboardPolicies.review",
} as const satisfies Record<PolicyDefaultAction, MessageKey>;

const EMPTY_PROJECT_LABEL_KEYS = {
  all: "DashboardPolicies.emptyProject",
  wallets: "DashboardPolicies.emptyProjectWallets",
  api_keys: "DashboardPolicies.emptyProjectApiKeys",
} as const satisfies Record<PoliciesTab, MessageKey>;

const SKELETON_IDS = ["one", "two", "three", "four", "five"] as const;

export function buildPoliciesHref(
  state: PoliciesUrlState,
  changes: Partial<PoliciesUrlState>
): string {
  const next = { ...state, ...changes };
  const params = new URLSearchParams();
  if (next.tab !== "all") params.set("tab", next.tab);
  params.set("page", String(next.page));
  params.set("pageSize", String(next.pageSize));
  if (next.query) params.set("query", next.query);
  if (next.status) params.set("status", next.status);
  return `/dashboard/policies?${params.toString()}`;
}

function targetHref(item: PolicyControlInventoryItem): string {
  return item.targetType === "wallet"
    ? `/dashboard/wallets/${encodeURIComponent(item.walletId)}`
    : "/dashboard/api-keys";
}

function walletPolicyHref(item: PolicyControlInventoryItem): string {
  return item.targetType === "wallet"
    ? `/dashboard/wallets/${encodeURIComponent(item.walletId)}/policy`
    : "/dashboard/api-keys";
}

function shorten(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function formatRelativeTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");
  return formatter.format(Math.round(elapsedHours / 24), "day");
}

function StatusBadge({ status }: { status: PolicyControlInventoryStatus }) {
  const t = useTranslations();
  return (
    <Badge variant={status === "active" ? "success" : "default"}>
      {t(STATUS_LABEL_KEYS[status])}
    </Badge>
  );
}

function formatDefaultAction(
  action: PolicyDefaultAction,
  t: ReturnType<typeof useTranslations>
): string {
  return t(DEFAULT_ACTION_LABEL_KEYS[action]);
}

function formatRules(item: PolicyControlInventoryItem, t: ReturnType<typeof useTranslations>) {
  if (item.status === "default_allow") return t("DashboardPolicies.noRestrictions");
  if (item.ruleCount === 1) return t("DashboardPolicies.singleRule");
  return t("DashboardPolicies.ruleCount", { count: item.ruleCount });
}

function formatBindings(item: PolicyControlInventoryItem, t: ReturnType<typeof useTranslations>) {
  if (item.targetType === "wallet") return "—";
  if (item.bindingScope === "all") return t("DashboardPolicies.allWallets");
  if (item.selectedWalletCount === 1) return t("DashboardPolicies.singleSelectedWallet");
  return t("DashboardPolicies.selectedWalletCount", { count: item.selectedWalletCount });
}

function TargetIdentity({ item }: { item: PolicyControlInventoryItem }) {
  const t = useTranslations();
  const Icon = item.targetType === "wallet" ? WalletIcon : KeyRoundIcon;
  const detail = item.targetType === "wallet" ? shorten(item.walletAddress) : item.apiKeyPrefix;
  return (
    <Link
      href={targetHref(item)}
      className="group flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-black/40 focus-visible:ring-offset-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary transition-colors group-hover:bg-fill-strong group-hover:text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-primary">{item.displayName}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-xs text-tertiary",
            item.targetType === "api_key" && "font-mono"
          )}
        >
          {detail ||
            (item.targetType === "wallet"
              ? t("DashboardPolicies.wallet")
              : t("DashboardPolicies.apiKey"))}
        </span>
      </span>
    </Link>
  );
}

function RowActions({ item }: { item: PolicyControlInventoryItem }) {
  const t = useTranslations();
  const policyHref = walletPolicyHref(item);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("DashboardPolicies.actions")}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {item.targetType === "wallet" ? (
          <>
            <DropdownMenuItem asChild>
              <Link href={policyHref}>{t("DashboardPolicies.configureWalletControls")}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={policyHref}>{t("DashboardPolicies.viewAudit")}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={policyHref}>{t("DashboardPolicies.viewRevisions")}</Link>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/api-keys">{t("DashboardPolicies.configureScope")}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/api-keys">{t("DashboardPolicies.viewBindings")}</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfigureMenu() {
  const t = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="whitespace-nowrap"
          iconLeft={<ShieldCheckIcon />}
          iconRight={<ChevronDownIcon />}
        >
          {t("DashboardPolicies.configureControls")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link href="/dashboard/wallets">{t("DashboardPolicies.walletControls")}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/api-keys">{t("DashboardPolicies.apiKeyControls")}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingRows() {
  return SKELETON_IDS.map((id) => (
    <TableRow key={id} data-policy-skeleton-row>
      <TableCell>
        <SkeletonBlock className="h-9 w-44" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-5 w-20" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-4 w-16" />
      </TableCell>
      <TableCell className="hidden xl:table-cell 2xl:w-[12%]">
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell className="hidden 2xl:table-cell 2xl:w-[15%]">
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell className="hidden 2xl:table-cell 2xl:w-[15%]">
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-8 w-8" />
      </TableCell>
    </TableRow>
  ));
}

function EmptyState({
  emptyLabelKey,
  filtered,
  onClear,
}: {
  emptyLabelKey: MessageKey;
  filtered: boolean;
  onClear: () => void;
}) {
  const t = useTranslations();
  return (
    <ListEmptyState
      icon={<ShieldCheckIcon className="size-5" />}
      message={filtered ? t("DashboardPolicies.noMatches") : t(emptyLabelKey)}
      action={
        filtered ? (
          <Button type="button" variant="secondary" onClick={onClear}>
            {t("DashboardPolicies.clearFilters")}
          </Button>
        ) : (
          <ConfigureMenu />
        )
      }
    />
  );
}

function InventoryTable({
  inventory,
  loading,
  emptyLabelKey,
  filtered,
  onClear,
}: {
  inventory: PolicyControlInventoryResponse | null;
  loading: boolean;
  emptyLabelKey: MessageKey;
  filtered: boolean;
  onClear: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const controls = inventory?.controls ?? [];
  if (!loading && controls.length === 0) {
    return (
      <div data-desktop-inventory className="hidden flex-1 lg:block">
        <EmptyState emptyLabelKey={emptyLabelKey} filtered={filtered} onClear={onClear} />
      </div>
    );
  }
  return (
    <div data-desktop-inventory className="hidden lg:block">
      <Table className="rounded-none border-0 [&::after]:hidden [&::before]:hidden [&_table]:min-w-0 [&_table]:table-fixed [&_td]:whitespace-nowrap [&_td]:py-4 [&_th]:whitespace-nowrap">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[45%] xl:w-[35%] 2xl:w-[22%]">
              {t("DashboardPolicies.target")}
            </TableHead>
            <TableHead className="w-[17%] xl:w-[16%] 2xl:w-[13%]">
              {t("DashboardPolicies.status")}
            </TableHead>
            <TableHead className="w-[28%] xl:w-[22%] 2xl:w-[15%]">
              {t("DashboardPolicies.defaultAction")}
            </TableHead>
            <TableHead className="hidden xl:table-cell xl:w-[17%] 2xl:w-[12%]">
              {t("DashboardPolicies.rules")}
            </TableHead>
            <TableHead className="hidden 2xl:table-cell 2xl:w-[15%]">
              {t("DashboardPolicies.bindings")}
            </TableHead>
            <TableHead className="hidden 2xl:table-cell 2xl:w-[15%]">
              {t("DashboardPolicies.lastUpdated")}
            </TableHead>
            <TableHead className="w-[10%] text-right">{t("DashboardPolicies.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? <LoadingRows /> : null}
          {!loading
            ? controls.map((item) => (
                <TableRow key={`${item.targetType}-${item.targetId}`}>
                  <TableCell>
                    <TargetIdentity item={item} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={item.status} />
                  </TableCell>
                  <TableCell className="text-sm text-secondary">
                    {formatDefaultAction(item.defaultAction, t)}
                  </TableCell>
                  <TableCell className="hidden text-sm text-secondary xl:table-cell">
                    {formatRules(item, t)}
                  </TableCell>
                  <TableCell className="hidden text-sm text-secondary 2xl:table-cell">
                    {formatBindings(item, t)}
                  </TableCell>
                  <TableCell className="hidden text-sm text-secondary 2xl:table-cell">
                    <time
                      dateTime={item.updatedAt}
                      title={new Date(item.updatedAt).toLocaleString(locale)}
                    >
                      {formatRelativeTime(item.updatedAt, locale)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions item={item} />
                  </TableCell>
                </TableRow>
              ))
            : null}
        </TableBody>
      </Table>
    </div>
  );
}

function MobileInventory({
  inventory,
  loading,
  emptyLabelKey,
  filtered,
  onClear,
}: {
  inventory: PolicyControlInventoryResponse | null;
  loading: boolean;
  emptyLabelKey: MessageKey;
  filtered: boolean;
  onClear: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const controls = inventory?.controls ?? [];
  return (
    <div data-mobile-inventory className="divide-y divide-border-default lg:hidden">
      {loading
        ? SKELETON_IDS.map((id) => (
            <div key={id} className="space-y-3 p-4">
              <SkeletonBlock className="h-9 w-44" />
              <SkeletonBlock className="h-4 w-full" />
            </div>
          ))
        : controls.map((item) => (
            <article key={`${item.targetType}-${item.targetId}`} className="space-y-4 p-4">
              <div className="flex items-start justify-between gap-3">
                <TargetIdentity item={item} />
                <RowActions item={item} />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-tertiary">{t("DashboardPolicies.status")}</p>
                  <div className="mt-1">
                    <StatusBadge status={item.status} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-tertiary">{t("DashboardPolicies.defaultAction")}</p>
                  <p className="mt-1 text-secondary">
                    {formatDefaultAction(item.defaultAction, t)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-tertiary">{t("DashboardPolicies.rules")}</p>
                  <p className="mt-1 text-secondary">{formatRules(item, t)}</p>
                </div>
                <div>
                  <p className="text-xs text-tertiary">{t("DashboardPolicies.bindings")}</p>
                  <p className="mt-1 text-secondary">{formatBindings(item, t)}</p>
                </div>
                <div>
                  <p className="text-xs text-tertiary">{t("DashboardPolicies.lastUpdated")}</p>
                  <time
                    className="mt-1 block text-secondary"
                    dateTime={item.updatedAt}
                    title={new Date(item.updatedAt).toLocaleString(locale)}
                  >
                    {formatRelativeTime(item.updatedAt, locale)}
                  </time>
                </div>
              </div>
            </article>
          ))}
      {!loading && controls.length === 0 ? (
        <EmptyState emptyLabelKey={emptyLabelKey} filtered={filtered} onClear={onClear} />
      ) : null}
    </div>
  );
}

export function PoliciesOverviewSurface({
  inventory,
  error,
  state,
  loading = false,
  searchValue,
  onSearchChange = () => undefined,
  onStateChange = () => undefined,
  onRetry = () => undefined,
}: PoliciesOverviewSurfaceProps) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();
  const filtered = Boolean(state.query || state.status);
  const emptyLabelKey = EMPTY_PROJECT_LABEL_KEYS[state.tab];
  const emptyProject =
    !loading && !error && !filtered && inventory !== null && inventory.controls.length === 0;
  const clearFilters = () => {
    onSearchChange("");
    onStateChange({ query: "", status: "", page: 1 });
  };
  const pageCount = Math.max(1, Math.ceil((inventory?.total ?? 0) / state.pageSize));
  const rangeStart = inventory?.total ? (state.page - 1) * state.pageSize + 1 : 0;
  const rangeEnd = Math.min(state.page * state.pageSize, inventory?.total ?? 0);

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col">
      <DashboardWorkspaceCard>
        <div className="border-b border-border-default px-4 py-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(160px,1fr)_170px_auto]">
            <Input
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t("DashboardPolicies.searchPlaceholder")}
              aria-label={t("DashboardPolicies.searchPlaceholder")}
              iconLeft={<SearchIcon />}
              action={
                searchValue ? (
                  <button
                    type="button"
                    aria-label={t("DashboardPolicies.clearSearch")}
                    onClick={() => onSearchChange("")}
                    className="rounded text-tertiary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
                  >
                    <XIcon className="size-5" />
                  </button>
                ) : undefined
              }
            />
            <Select
              value={state.status || "all"}
              onValueChange={(value) =>
                onStateChange({
                  status: value === "all" ? "" : (value as PolicyControlInventoryStatus),
                  page: 1,
                })
              }
            >
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
            {emptyProject ? null : <ConfigureMenu />}
          </div>
        </div>

        <motion.div
          key={state.tab}
          initial={reducedMotion ? false : { opacity: 0.94, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
          className="flex min-w-0 flex-1 flex-col"
          aria-busy={loading}
        >
          {error ? (
            <ListEmptyState
              message={t("DashboardPolicies.loadError")}
              action={
                <Button type="button" variant="secondary" onClick={onRetry}>
                  {t("DashboardPolicies.retry")}
                </Button>
              }
            />
          ) : (
            <>
              <InventoryTable
                inventory={inventory}
                loading={loading}
                emptyLabelKey={emptyLabelKey}
                filtered={filtered}
                onClear={clearFilters}
              />
              <MobileInventory
                inventory={inventory}
                loading={loading}
                emptyLabelKey={emptyLabelKey}
                filtered={filtered}
                onClear={clearFilters}
              />
              {!loading && inventory && inventory.controls.length > 0 ? (
                <PaginatedFooter
                  className="mt-auto"
                  page={state.page}
                  pageCount={pageCount}
                  onPageChange={(page) => onStateChange({ page })}
                  summary={t("DashboardPolicies.range", {
                    start: rangeStart,
                    end: rangeEnd,
                    total: inventory.total,
                  })}
                  pageSizeControl={{
                    pageSize: state.pageSize,
                    onPageSizeChange: (pageSize) => onStateChange({ pageSize, page: 1 }),
                  }}
                />
              ) : null}
            </>
          )}
        </motion.div>
      </DashboardWorkspaceCard>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function PoliciesOverview({ inventory, error, state }: PoliciesOverviewProps) {
  const router = useRouter();
  const activeTab = parsePoliciesTab(useDashboardTab());
  const stateRef = useRef(state);
  const [displayState, setDisplayState] = useState(state);
  const [searchValue, setSearchValue] = useState(state.query);
  const [isPending, startTransition] = useTransition();
  const debouncedSearch = useDebounce(searchValue.trim(), 300);
  // The query this component last wrote to the URL. Lets the URL→input sync below
  // distinguish its own echoes from genuine external navigation.
  const lastPushedQueryRef = useRef(state.query);

  useEffect(() => {
    stateRef.current = state;
    setDisplayState(state);
  }, [state]);
  // Mirror the URL into the input only on *external* navigation (e.g. back/forward).
  // Ignoring echoes of our own pushes stops a slow RSC round-trip from overwriting text
  // the user has typed since it was dispatched — the "search sticks on old text" bug.
  useEffect(() => {
    if (state.query !== lastPushedQueryRef.current) {
      lastPushedQueryRef.current = state.query;
      setSearchValue(state.query);
    }
  }, [state.query]);
  useEffect(() => {
    const currentState = stateRef.current;
    if (debouncedSearch !== currentState.query) {
      lastPushedQueryRef.current = debouncedSearch;
      const nextState = { ...currentState, query: debouncedSearch, page: 1 };
      stateRef.current = nextState;
      setDisplayState(nextState);
      startTransition(() => {
        router.replace(buildPoliciesHref(currentState, { query: debouncedSearch, page: 1 }), {
          scroll: false,
        });
      });
    }
  }, [debouncedSearch, router]);

  useEffect(() => {
    for (const tab of POLICIES_TABS) {
      if (tab !== stateRef.current.tab) {
        router.prefetch(buildPoliciesHref(stateRef.current, { tab, page: 1 }));
      }
    }
  }, [router]);

  const updateState = useCallback(
    (changes: Partial<PoliciesUrlState>) => {
      const currentState = stateRef.current;
      const nextState = { ...currentState, ...changes };
      stateRef.current = nextState;
      // Clearing filters routes a query change through here too — record it as our own
      // push so the URL→input sync doesn't later clobber freshly typed text.
      if (changes.query !== undefined) {
        lastPushedQueryRef.current = changes.query;
      }
      setDisplayState(nextState);
      startTransition(() => {
        router.replace(buildPoliciesHref(currentState, changes), { scroll: false });
      });
    },
    [router]
  );

  // The header tabs rewrite `?tab=` shallowly (no RSC refetch), so the workspace
  // re-runs the server fetch itself when the URL tab diverges from the loaded data.
  // During hydration the snapshot behind `activeTab` lags the real URL (its server
  // snapshot is always null), so the effect defers to the URL and waits for the
  // store to re-fire with the settled value.
  useEffect(() => {
    if (activeTab !== parsePoliciesTab(readDashboardTabFromUrl())) {
      return;
    }
    if (activeTab !== stateRef.current.tab) {
      updateState({ tab: activeTab, page: 1 });
    }
  }, [activeTab, updateState]);

  return (
    <PoliciesOverviewSurface
      inventory={inventory}
      error={isPending ? false : error}
      state={displayState}
      loading={isPending}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      onStateChange={updateState}
      onRetry={() => router.refresh()}
    />
  );
}

export function PoliciesOverviewSkeleton() {
  return (
    <PoliciesOverviewSurface
      inventory={null}
      error={false}
      state={{ tab: "all", query: "", status: "", page: 1, pageSize: 25 }}
      searchValue=""
      loading
    />
  );
}
