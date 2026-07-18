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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";

export type PoliciesTab = "all" | "wallets" | "api_keys";

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
  onTabPreload?: (tab: PoliciesTab) => void;
  onRetry?: () => void;
}

const TABS: Array<{ id: PoliciesTab; labelKey: MessageKey }> = [
  { id: "all", labelKey: "DashboardPolicies.all" },
  { id: "wallets", labelKey: "DashboardPolicies.wallets" },
  { id: "api_keys", labelKey: "DashboardPolicies.apiKeys" },
];

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

const SKELETON_IDS = ["one", "two", "three", "four", "five"] as const;

export function buildPoliciesHref(
  state: PoliciesUrlState,
  changes: Partial<PoliciesUrlState>
): string {
  const next = { ...state, ...changes };
  const params = new URLSearchParams({
    tab: next.tab,
    page: String(next.page),
    pageSize: String(next.pageSize),
  });
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
        <Button iconLeft={<ShieldCheckIcon />} iconRight={<ChevronDownIcon />}>
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
      <TableCell>
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-4 w-20" />
      </TableCell>
      <TableCell>
        <SkeletonBlock className="h-8 w-8" />
      </TableCell>
    </TableRow>
  ));
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
        <ShieldCheckIcon className="size-5" />
      </span>
      <p className="mt-4 text-sm font-medium text-primary">
        {filtered ? t("DashboardPolicies.noMatches") : t("DashboardPolicies.emptyProject")}
      </p>
      <div className="mt-4">
        {filtered ? (
          <Button type="button" variant="secondary" onClick={onClear}>
            {t("DashboardPolicies.clearFilters")}
          </Button>
        ) : (
          <ConfigureMenu />
        )}
      </div>
    </div>
  );
}

function InventoryTable({
  inventory,
  loading,
  filtered,
  onClear,
}: {
  inventory: PolicyControlInventoryResponse | null;
  loading: boolean;
  filtered: boolean;
  onClear: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const controls = inventory?.controls ?? [];
  if (!loading && controls.length === 0) {
    return (
      <div data-desktop-inventory className="hidden lg:block">
        <EmptyState filtered={filtered} onClear={onClear} />
      </div>
    );
  }
  return (
    <div data-desktop-inventory className="hidden lg:block">
      <Table className="rounded-none border-0 [&_table]:min-w-[900px] [&_table]:table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[24%]">{t("DashboardPolicies.target")}</TableHead>
            <TableHead className="w-[12%]">{t("DashboardPolicies.status")}</TableHead>
            <TableHead className="w-[13%]">{t("DashboardPolicies.defaultAction")}</TableHead>
            <TableHead className="w-[11%]">{t("DashboardPolicies.rules")}</TableHead>
            <TableHead className="w-[14%]">{t("DashboardPolicies.bindings")}</TableHead>
            <TableHead className="w-[16%]">{t("DashboardPolicies.lastUpdated")}</TableHead>
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
                  <TableCell className="text-sm text-secondary">{formatRules(item, t)}</TableCell>
                  <TableCell className="text-sm text-secondary">
                    {formatBindings(item, t)}
                  </TableCell>
                  <TableCell className="text-sm text-secondary">
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
  filtered,
  onClear,
}: {
  inventory: PolicyControlInventoryResponse | null;
  loading: boolean;
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
        <EmptyState filtered={filtered} onClear={onClear} />
      ) : null}
    </div>
  );
}

function SummaryRail({
  inventory,
  loading,
  error,
}: {
  inventory: PolicyControlInventoryResponse | null;
  loading: boolean;
  error: boolean;
}) {
  const t = useTranslations();
  const rows = inventory
    ? ([
        ["default_allow", t("DashboardPolicies.defaultAllow"), inventory.summary.defaultAllow],
        ["draft", t("DashboardPolicies.draft"), inventory.summary.draft],
        ["active", t("DashboardPolicies.active"), inventory.summary.active],
        ["disabled", t("DashboardPolicies.disabled"), inventory.summary.disabled],
        [
          "api_key_bindings",
          t("DashboardPolicies.apiKeyBindings"),
          inventory.summary.totalApiKeyBindings,
        ],
      ] as const)
    : [];
  return (
    <aside
      className="border-t border-border-default bg-fill-subtle p-5 lg:border-t-0 lg:border-l"
      data-summary-rail
    >
      <h2 className="text-sm font-semibold text-primary">{t("DashboardPolicies.policySummary")}</h2>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardPolicies.summaryDescription")}
      </p>
      {loading ? (
        <div className="mt-6 space-y-4" data-summary-skeleton>
          {SKELETON_IDS.map((id) => (
            <div key={id} className="flex items-center justify-between gap-4">
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-6 w-8" />
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="mt-6 text-sm text-error">{t("DashboardPolicies.loadError")}</p>
      ) : (
        <dl className="mt-6 divide-y divide-border-default">
          {rows.map(([id, label, value]) => (
            <div key={id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
              <dt className="text-sm text-secondary">{label}</dt>
              <dd
                className={cn(
                  "text-lg font-medium text-primary",
                  id === "active" && value > 0 && "text-success"
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
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
  onTabPreload = () => undefined,
  onRetry = () => undefined,
}: PoliciesOverviewSurfaceProps) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();
  const filtered = state.tab !== "all" || Boolean(state.query || state.status);
  const clearFilters = () => {
    onSearchChange("");
    onStateChange({ tab: "all", query: "", status: "", page: 1 });
  };
  const pageCount = Math.max(1, Math.ceil((inventory?.total ?? 0) / state.pageSize));
  const rangeStart = inventory?.total ? (state.page - 1) * state.pageSize + 1 : 0;
  const rangeEnd = Math.min(state.page * state.pageSize, inventory?.total ?? 0);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-3 pt-5 pb-6 md:px-6">
      <div className="overflow-hidden rounded-lg border border-border-default bg-surface-raised">
        <div className="border-b border-border-default px-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch xl:justify-between xl:gap-6">
            <div
              className="flex h-12 shrink-0 gap-6 overflow-x-auto xl:h-16"
              aria-label={t("DashboardPolicies.target")}
              role="tablist"
            >
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={state.tab === tab.id}
                  onClick={() => onStateChange({ tab: tab.id, page: 1 })}
                  onFocus={() => onTabPreload(tab.id)}
                  onPointerEnter={() => onTabPreload(tab.id)}
                  className={cn(
                    "relative h-full whitespace-nowrap rounded-sm text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-black/40 focus-visible:ring-offset-2",
                    state.tab === tab.id ? "text-primary" : "text-secondary hover:text-primary"
                  )}
                >
                  {t(tab.labelKey)}
                  {state.tab === tab.id ? (
                    <motion.span
                      layoutId="policies-active-tab"
                      className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary"
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 520, damping: 42, mass: 0.7 }
                      }
                    />
                  ) : null}
                </button>
              ))}
            </div>

            <div className="grid gap-2 pb-4 sm:grid-cols-[minmax(240px,1fr)_180px_auto] xl:w-[680px] xl:py-3">
              <Input
                value={searchValue}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={t("DashboardPolicies.searchPlaceholder")}
                aria-label={t("DashboardPolicies.searchPlaceholder")}
                iconLeft={<SearchIcon />}
                iconRight={
                  searchValue ? (
                    <button
                      type="button"
                      aria-label={t("DashboardPolicies.clearSearch")}
                      onClick={() => onSearchChange("")}
                      className="rounded text-tertiary hover:text-primary"
                    >
                      <XIcon />
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
              <ConfigureMenu />
            </div>
          </div>
        </div>

        <motion.div
          key={state.tab}
          initial={reducedMotion ? false : { opacity: 0.94, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
          className="grid lg:grid-cols-[minmax(0,1fr)_300px]"
          aria-busy={loading}
        >
          <section className="min-w-0">
            {error ? (
              <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardPolicies.loadError")}
                </p>
                <Button type="button" variant="secondary" className="mt-4" onClick={onRetry}>
                  {t("DashboardPolicies.retry")}
                </Button>
              </div>
            ) : (
              <>
                <InventoryTable
                  inventory={inventory}
                  loading={loading}
                  filtered={filtered}
                  onClear={clearFilters}
                />
                <MobileInventory
                  inventory={inventory}
                  loading={loading}
                  filtered={filtered}
                  onClear={clearFilters}
                />
                {!loading && inventory && inventory.controls.length > 0 ? (
                  <div className="flex flex-col gap-4 border-t border-border-default p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-secondary">
                        {t("DashboardPolicies.rowsPerPage")}
                      </span>
                      <Select
                        value={String(state.pageSize)}
                        onValueChange={(value) =>
                          onStateChange({ pageSize: Number(value), page: 1 })
                        }
                        className="w-20"
                      >
                        {[10, 25, 50, 100].map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                    <ArrowPagination
                      page={state.page}
                      pageCount={pageCount}
                      onPageChange={(page) => onStateChange({ page })}
                      summary={t("DashboardPolicies.range", {
                        start: rangeStart,
                        end: rangeEnd,
                        total: inventory.total,
                      })}
                    />
                  </div>
                ) : null}
              </>
            )}
          </section>
          <SummaryRail inventory={inventory} loading={loading} error={error} />
        </motion.div>
      </div>
    </div>
  );
}

export function PoliciesOverview({ inventory, error, state }: PoliciesOverviewProps) {
  const router = useRouter();
  const stateRef = useRef(state);
  const [displayState, setDisplayState] = useState(state);
  const [searchValue, setSearchValue] = useState(state.query);
  const [isPending, startTransition] = useTransition();
  const debouncedSearch = useDebounce(searchValue.trim(), 300);

  useEffect(() => {
    stateRef.current = state;
    setDisplayState(state);
  }, [state]);
  useEffect(() => setSearchValue(state.query), [state.query]);
  useEffect(() => {
    const currentState = stateRef.current;
    if (debouncedSearch !== currentState.query) {
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

  const preloadTab = useCallback(
    (tab: PoliciesTab) => {
      if (tab === stateRef.current.tab) return;
      router.prefetch(buildPoliciesHref(stateRef.current, { tab, page: 1 }));
    },
    [router]
  );

  useEffect(() => {
    for (const tab of TABS) preloadTab(tab.id);
  }, [preloadTab]);

  const updateState = (changes: Partial<PoliciesUrlState>) => {
    const currentState = stateRef.current;
    const nextState = { ...currentState, ...changes };
    stateRef.current = nextState;
    setDisplayState(nextState);
    startTransition(() => {
      router.replace(buildPoliciesHref(currentState, changes), { scroll: false });
    });
  };

  return (
    <PoliciesOverviewSurface
      inventory={inventory}
      error={isPending ? false : error}
      state={displayState}
      loading={isPending}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      onStateChange={updateState}
      onTabPreload={preloadTab}
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
