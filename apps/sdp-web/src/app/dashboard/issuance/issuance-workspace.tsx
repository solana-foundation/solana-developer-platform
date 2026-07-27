"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Coins,
  Hash,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import { CreateIssuanceTokenModal } from "./create-token-modal";
import {
  DEFAULT_ISSUANCE_FILTERS,
  filterAndSortTokens,
  IssuanceFilterPopover,
  type IssuanceFilterState,
} from "./issuance-filter-popover";
import { IssuancePlaygroundLoading } from "./issuance-playground-loading";
import {
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenChips,
  getTokenTypeLabel,
  type IssuanceTokenView,
  type TokenView,
} from "./issuance-token-fields";
import { IssuanceTokenList, ManageKebab } from "./issuance-token-list";

// Full-page draft wizard when the Asset Profiles UI flag is on; the legacy
// create-token-modal.tsx handles creation when it's off.
const CREATE_DRAFT_PATH = "/dashboard/issuance/create";

const IssuancePlayground = dynamic(
  () => import("./issuance-playground").then((module) => module.IssuancePlayground),
  {
    loading: () => <IssuancePlaygroundLoading />,
  }
);

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

interface IssuanceWorkspaceProps {
  assetProfilesEnabled: boolean;
  tokens: IssuanceTokenView[];
  templates: IssuanceTemplateOption[];
  apiKeys: IssuanceApiKeyOption[];
  signerWallets: PaymentsDashboardWallet[];
  apiBaseUrl: string | null;
  templatesError: string | null;
  tokensNotice: string | null;
  signerWalletsError: string | null;
}

// localStorage key for the grid ⇄ list view toggle.
const VIEW_STORAGE_KEY = "sdp.issuance.tokenView";

// Grid ⇄ list cross-fade. Matches the workspace tab-shell transition so the two
// views dissolve into each other rather than hard-swapping. `mode="wait"` lets
// the outgoing layout leave before the (differently-sized) incoming one mounts,
// avoiding a stacked-height jump mid-animation.
const viewTransition = { duration: 0.18, ease: "easeOut" } as const;

// Classes for the scrolling overview panel (the tab shell's `overflow-y-auto` div —
// the shell locks the viewport, so that inner panel is what actually scrolls).
//
// `overflow-anchor: none` is deliberate. Expanding a list row grows the scroll extent
// (transformed overflow counts toward scrollHeight) and collapsing shrinks it again.
// Chrome's scroll anchoring reacts to that extent change by reconciling scrollTop —
// a discrete layout hit that showed up as an intermittent stutter on collapse, and
// disabling it measurably smoothed the close. Anchoring exists to stop content from
// jumping when something above the viewport resizes asynchronously; this list only
// ever resizes in direct response to a click, so there is nothing here for it to
// protect and we pay the cost for no benefit. Scoped to issuance rather than added
// to the shared panel class so other dashboard surfaces keep the default behaviour.
// `pt-0` hands the panel's top padding to the pinned header below, so the header
// keeps its breathing room once it is stuck to the top of the scrollport.
const ISSUANCE_OVERVIEW_PANEL_CLASS = "pt-0 [overflow-anchor:none]";

// The pinned header (toolbar + asset count) sits in the scroll flow and sticks to
// the top, so cards pass *behind* it — which only works with an opaque backdrop.
// The scrolling panel's own backdrop is the shell's `--surface` seen through the
// content section's `bg-surface-raised/80`; alpha compositing is a plain sRGB mix,
// so this color-mix reproduces that composite exactly, in both themes.
const PINNED_HEADER_BG =
  "bg-[color-mix(in_srgb,var(--color-surface-raised)_80%,var(--color-surface))]";

export function IssuanceWorkspace({
  assetProfilesEnabled,
  tokens,
  templates,
  apiKeys,
  apiBaseUrl,
  templatesError,
  tokensNotice,
  signerWallets,
  signerWalletsError,
}: IssuanceWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const router = useDashboardRouter();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<IssuanceFilterState>(DEFAULT_ISSUANCE_FILTERS);
  const [isCreateTokenModalOpen, setIsCreateTokenModalOpen] = useState(false);
  const isPlaygroundTab = issuanceTab === "playground";

  // Grid ⇄ list view (persisted).
  const [view, setView] = useState<TokenView>("grid");
  const reduceMotion = useReducedMotion();

  // Expanded list rows. Held here rather than in IssuanceTokenList because
  // expand-all works off the filtered set, which lives in this component.
  const [openTokenIds, setOpenTokenIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTokenRow = useCallback((id: string) => {
    setOpenTokenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const collapseAllTokenRows = useCallback(() => setOpenTokenIds(new Set()), []);

  useEffect(() => {
    try {
      const storedView = localStorage.getItem(VIEW_STORAGE_KEY);
      if (storedView === "grid" || storedView === "list") {
        setView(storedView);
      }
    } catch {
      // Ignore storage access errors (private mode, etc.).
    }
  }, []);

  const changeView = (next: TokenView) => {
    setView(next);
    // The list unmounts on a view switch and re-measures its panels on mount, so
    // carrying expanded rows across would replay the slide. Start collapsed.
    collapseAllTokenRows();
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Ignore.
    }
  };

  // Asset Profiles UI flag: on → full-page wizard; off → legacy modal.
  const startTokenCreation = () => {
    if (assetProfilesEnabled) {
      router.push(CREATE_DRAFT_PATH);
      return;
    }
    setIsCreateTokenModalOpen(true);
  };

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) {
      return;
    }

    const preloadPlayground = () => {
      void import("./issuance-playground");
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadPlayground);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preloadPlayground, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    return stored ?? "";
  }, [selectedPlaygroundApiKey, selectedPlaygroundApiKeyPrefix]);

  // Template options for the filter popover — only templates actually present in
  // the token set, labelled via the shared catalog and sorted by label.
  const templateOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const token of tokens) {
      if (token.template && !seen.has(token.template)) {
        seen.set(token.template, getTokenTypeLabel(token.template, t));
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [tokens, t]);

  const updateFilters = (changes: Partial<IssuanceFilterState>) => {
    setFilters((prev) => ({ ...prev, ...changes }));
  };
  const clearFilters = () => setFilters(DEFAULT_ISSUANCE_FILTERS);

  const filteredTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const searched = needle
      ? tokens.filter(
          (token) =>
            token.name.toLowerCase().includes(needle) ||
            token.symbol.toLowerCase().includes(needle) ||
            token.id.toLowerCase().includes(needle) ||
            (token.mintAddress ? token.mintAddress.toLowerCase().includes(needle) : false)
        )
      : tokens;
    return filterAndSortTokens(searched, filters);
  }, [tokens, search, filters]);
  const hasTokens = tokens.length > 0;
  // Which way the expand/collapse-all control points. Counts only rows that are on
  // screen, so an expanded row hidden by a filter can't leave the control claiming
  // "collapse" with nothing visibly open.
  const hasOpenTokenRows = filteredTokens.some((token) => openTokenIds.has(token.id));
  // Expand-all covers the filtered set — the rows you can see are the rows it opens.
  const expandAllTokenRows = () =>
    setOpenTokenIds(new Set(filteredTokens.map((token) => token.id)));

  const playgroundContent = (
    <IssuancePlayground
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={playgroundApiKeyValue}
      hasActiveApiKeys={apiKeys.length > 0}
      templates={templates}
      templatesError={templatesError}
      tokens={tokens}
    />
  );

  // Legacy overview when the Asset Profiles UI flag is off: the old card grid
  // with no classification chips, filters, view toggle, or kebab — just search,
  // a Type/Supply/Created stat box, and a Manage link per token.
  if (!assetProfilesEnabled) {
    const needle = search.trim().toLowerCase();
    const legacyFilteredTokens = needle
      ? tokens.filter(
          (token) =>
            token.name.toLowerCase().includes(needle) ||
            token.symbol.toLowerCase().includes(needle) ||
            token.id.toLowerCase().includes(needle) ||
            (token.mintAddress ? token.mintAddress.toLowerCase().includes(needle) : false)
        )
      : tokens;
    return (
      <DashboardWorkspaceTabShell
        isPlaygroundTab={isPlaygroundTab}
        overviewClassName={ISSUANCE_OVERVIEW_PANEL_CLASS}
        overviewKey="tokens-tab"
        overview={
          <>
            {tokensNotice && tokens.length > 0 ? (
              <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardIssuance.workspace.tokenListUnavailable")}
                </p>
                <p className="mt-1 text-sm text-secondary">{tokensNotice}</p>
              </div>
            ) : null}

            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-tertiary" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  className="h-10 rounded-[10px] border-border-default bg-surface-raised pl-9"
                  placeholder={t("DashboardIssuance.workspace.search")}
                />
              </div>
              <Button
                type="button"
                className="h-10 rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90"
                onClick={startTokenCreation}
              >
                {t("DashboardIssuance.workspace.createDraft")}
              </Button>
            </div>

            {hasTokens && legacyFilteredTokens.length === 0 ? (
              <p className="text-sm text-secondary">
                {t("DashboardIssuance.workspace.noTokensMatch")}
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {legacyFilteredTokens.map((token) => {
                const deploymentStatus = getDeploymentStatus(token);
                return (
                  <article
                    key={token.id}
                    data-testid={`token-card-${token.id}`}
                    className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5"
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="h-14 w-14 overflow-hidden rounded-full border border-border-default bg-fill-subtle">
                        {token.imageUrl ? (
                          // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
                          <img
                            src={token.imageUrl}
                            alt={t("DashboardIssuance.workspace.tokenLogo", { name: token.name })}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-tertiary">
                            {token.symbol.slice(0, 1) || "?"}
                          </div>
                        )}
                      </div>
                      <span
                        data-testid={`token-card-status-${token.id}`}
                        className={[
                          "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium tracking-[0.02em] capitalize",
                          deploymentStatus === "active"
                            ? "bg-success-bg text-success"
                            : "bg-fill text-secondary",
                        ].join(" ")}
                      >
                        {deploymentStatus === "active"
                          ? t("DashboardIssuance.workspace.active")
                          : t("DashboardIssuance.workspace.draft")}
                      </span>
                    </div>
                    <p className="text-sm font-medium tracking-wide text-tertiary">
                      {token.symbol}
                    </p>
                    <h3 className="mt-1 text-[30px] leading-[1.1] font-medium text-primary">
                      {token.name}
                    </h3>

                    <div className="mt-6 space-y-2 rounded-xl border border-border-subtle bg-fill-subtle p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-tertiary">
                          {t("DashboardIssuance.workspace.type")}
                        </span>
                        <span className="font-medium text-primary">
                          {getTokenTypeLabel(token.template, t)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-tertiary">
                          {t("DashboardIssuance.workspace.supply")}
                        </span>
                        <span className="font-medium text-primary">
                          {formatSupply(token.totalSupply, locale)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-tertiary">
                          {t("DashboardIssuance.workspace.created")}
                        </span>
                        <span className="font-medium text-primary">
                          {formatDate(token.createdAt, locale)}
                        </span>
                      </div>
                    </div>

                    <div className="mt-auto pt-3">
                      <Link
                        href={`/dashboard/issuance/${token.id}`}
                        className="inline-flex h-11 w-full items-center justify-center rounded-[10px] border border-border-default bg-surface-raised text-sm font-medium text-primary transition-colors hover:border-border-strong hover:bg-fill-subtle"
                      >
                        {t("DashboardIssuance.workspace.manage")}
                      </Link>
                    </div>
                  </article>
                );
              })}

              <button
                type="button"
                onClick={startTokenCreation}
                data-testid="token-add-card"
                className="flex min-h-[340px] items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
                aria-label={t("DashboardIssuance.workspace.addNewToken")}
              >
                <Plus className="h-6 w-6" />
              </button>
            </div>

            <CreateIssuanceTokenModal
              open={isCreateTokenModalOpen}
              onOpenChange={setIsCreateTokenModalOpen}
              signerWallets={signerWallets}
              signerWalletsError={signerWalletsError}
              hideTrigger
            />
          </>
        }
        playground={playgroundContent}
      />
    );
  }

  return (
    <DashboardWorkspaceTabShell
      isPlaygroundTab={isPlaygroundTab}
      overviewClassName={ISSUANCE_OVERVIEW_PANEL_CLASS}
      overviewKey="tokens-tab"
      overview={
        <>
          {/* Pinned header — same in both views. Negative margins bleed the backdrop
              across the panel's horizontal padding so nothing shows through at the
              edges as content scrolls behind it. z sits above the list's per-row
              stacking ladder, whose z-indices run up to the row count. */}
          <div
            className={cn(
              "sticky top-0 z-[1000] -mx-3 space-y-4 px-3 pt-6 pb-4 md:-mx-6 md:px-6",
              PINNED_HEADER_BG
            )}
          >
            {tokensNotice && tokens.length > 0 ? (
              <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
                <p className="text-sm font-medium text-primary">
                  {t("DashboardIssuance.workspace.tokenListUnavailable")}
                </p>
                <p className="mt-1 text-sm text-secondary">{tokensNotice}</p>
              </div>
            ) : null}

            {/* Toolbar: stacks into two rows below sm, one row from sm up. The
              breakpoint is the viewport, not the toolbar width — at ≥sm the sidebar
              is hidden below xl, so even iPad portrait has room for a single row. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3 sm:flex-1">
                <div className="flex-1">
                  <Input
                    value={search}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSearch(value);
                    }}
                    // The DS input paints its border on an inner span via
                    // --input-border-*, so border-* classes are inert — override the
                    // vars to 1px + shared tokens to match the filter/toggle buttons.
                    className="h-10 rounded-[10px] bg-surface-raised [--input-border-hover:var(--color-border-strong)] [--input-border-idle:var(--color-border-default)] [--input-border-width:1px]"
                    placeholder={t("DashboardIssuance.workspace.search")}
                    iconLeft={<Search />}
                  />
                </div>
                {/* Filter & sort — icon-only trigger opening a popover. */}
                <IssuanceFilterPopover
                  filters={filters}
                  onChange={updateFilters}
                  onClear={clearFilters}
                  templateOptions={templateOptions}
                />
                {/* Grid ⇄ list toggle — icon shows the view it switches to (grid
                  shows the list icon, and vice versa). */}
                <button
                  type="button"
                  aria-label={t(
                    view === "grid"
                      ? "DashboardIssuance.workspace.viewSwitchToList"
                      : "DashboardIssuance.workspace.viewSwitchToGrid"
                  )}
                  onClick={() => changeView(view === "grid" ? "list" : "grid")}
                  className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border border-border-default bg-surface-raised text-secondary outline-none transition-colors hover:border-border-strong hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
                >
                  {view === "grid" ? (
                    <List className="h-4 w-4" />
                  ) : (
                    <LayoutGrid className="h-4 w-4" />
                  )}
                </button>
              </div>
              <Button
                type="button"
                className="h-10 w-full cursor-pointer rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90 sm:w-auto"
                onClick={startTokenCreation}
                iconLeft={<Plus className="h-4 w-4" />}
              >
                {t("DashboardIssuance.workspace.createDraft")}
              </Button>
            </div>

            {/* Asset count, and — in list view — the expand/collapse-all control.
                Fixed height and always mounted, so the header's height never
                changes as rows open and close. */}
            <div className="flex h-6 items-center justify-between px-1">
              <p className="text-xs text-tertiary">
                {t("DashboardIssuance.list.assetsCount", { count: filteredTokens.length })}
              </p>
              {view === "list" ? (
                <button
                  type="button"
                  data-testid="token-collapse-all"
                  onClick={hasOpenTokenRows ? collapseAllTokenRows : expandAllTokenRows}
                  className="-mr-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-secondary outline-none transition-colors hover:bg-fill hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
                >
                  {hasOpenTokenRows ? (
                    <ChevronsDownUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {t(
                    hasOpenTokenRows
                      ? "DashboardIssuance.workspace.collapseAll"
                      : "DashboardIssuance.workspace.expandAll"
                  )}
                </button>
              ) : null}
            </div>
          </div>

          {hasTokens && filteredTokens.length === 0 ? (
            <p className="mb-4 text-sm text-secondary">
              {t("DashboardIssuance.workspace.noTokensMatch")}
            </p>
          ) : null}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={viewTransition}
            >
              {view === "list" ? (
                <IssuanceTokenList
                  tokens={filteredTokens}
                  signerWallets={signerWallets}
                  openIds={openTokenIds}
                  onToggle={toggleTokenRow}
                  onCreate={startTokenCreation}
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {filteredTokens.map((token) => {
                    const deploymentStatus = getDeploymentStatus(token);
                    const chips = getTokenChips(token, t);
                    return (
                      <article
                        key={token.id}
                        data-testid={`token-card-${token.id}`}
                        className="relative flex min-h-[240px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 transition-colors hover:border-primary/40"
                      >
                        {/* Full-bleed overlay link makes the whole tile navigate; the
                        kebab sits above it (z-10) so its menu stays clickable. */}
                        <Link
                          href={`/dashboard/issuance/${token.id}`}
                          aria-label={t("DashboardIssuance.workspace.manageAsset", {
                            name: token.name,
                          })}
                          className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
                        />
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-border-default bg-fill-subtle">
                              {token.imageUrl ? (
                                // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
                                <img
                                  src={token.imageUrl}
                                  alt={t("DashboardIssuance.workspace.tokenLogo", {
                                    name: token.name,
                                  })}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-tertiary">
                                  {token.symbol.slice(0, 1) || "?"}
                                </div>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-medium tracking-wide text-tertiary">
                                {token.symbol}
                              </p>
                              <h3 className="mt-0.5 truncate text-lg font-medium leading-tight text-primary">
                                {token.name}
                              </h3>
                            </div>
                          </div>
                          <span
                            data-testid={`token-card-status-${token.id}`}
                            className={[
                              "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize",
                              deploymentStatus === "active"
                                ? "bg-success-bg text-success"
                                : "bg-fill text-secondary",
                            ].join(" ")}
                          >
                            {deploymentStatus === "active"
                              ? t("DashboardIssuance.workspace.active")
                              : t("DashboardIssuance.workspace.draft")}
                          </span>
                        </div>

                        {chips.length > 0 ? (
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            {chips.map((chip) => {
                              const Icon = chip.icon;
                              return (
                                <span
                                  key={chip.label}
                                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs text-secondary"
                                >
                                  {Icon ? (
                                    <Icon
                                      className="h-3.5 w-3.5 shrink-0 text-tertiary"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  <span className="truncate">{chip.label}</span>
                                </span>
                              );
                            })}
                          </div>
                        ) : null}

                        {/* Same icon + label pairing as the list view's CollapsedStat
                        (Coins/Hash/Clock), so a token reads identically in both views. */}
                        <div className="mt-6 grid grid-cols-2 gap-4">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1 text-xs text-tertiary">
                              <Coins className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">
                                {t("DashboardIssuance.workspace.supply")}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-sm font-normal text-primary">
                              {formatSupply(token.totalSupply, locale)}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="flex items-center gap-1 text-xs text-tertiary">
                              <Hash className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">
                                {t("DashboardIssuance.list.decimals")}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-sm font-normal text-primary">
                              {token.decimals}
                            </p>
                          </div>
                        </div>

                        <div className="mt-auto flex items-end justify-between pt-4">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1 text-xs text-tertiary">
                              <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">
                                {t("DashboardIssuance.workspace.created")}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-sm font-normal text-primary">
                              {formatDate(token.createdAt, locale)}
                            </p>
                          </div>
                          <div className="relative z-10">
                            <ManageKebab token={token} icon={Settings2} triggerVariant="outline" />
                          </div>
                        </div>
                      </article>
                    );
                  })}

                  <button
                    type="button"
                    onClick={startTokenCreation}
                    data-testid="token-add-card"
                    className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
                  >
                    <Plus className="h-6 w-6" />
                    <span className="text-sm font-medium">
                      {t("DashboardIssuance.workspace.addNewToken")}
                    </span>
                  </button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </>
      }
      playground={playgroundContent}
    />
  );
}
