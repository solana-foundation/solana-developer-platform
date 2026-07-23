"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { LayoutGrid, List, Plus, Search, Settings2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { isAssetProfilesUiEnabled } from "@/lib/asset-profiles-feature";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
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

export function IssuanceWorkspace({
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
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Ignore.
    }
  };

  // Asset Profiles UI flag: on → full-page wizard; off → legacy modal.
  const assetProfilesUiEnabled = isAssetProfilesUiEnabled();
  const startTokenCreation = () => {
    if (assetProfilesUiEnabled) {
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
  if (!assetProfilesUiEnabled) {
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
        overviewClassName="space-y-6"
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
                      <div className="h-14 w-14 overflow-hidden rounded-full border border-border-default bg-[white]">
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
      overviewClassName="space-y-6"
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
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-border-default bg-surface-raised text-secondary outline-none transition-colors hover:border-border-strong hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
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
              className="h-10 w-full rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90 sm:w-auto"
              onClick={startTokenCreation}
              iconLeft={<Plus className="h-4 w-4" />}
            >
              {t("DashboardIssuance.workspace.createDraft")}
            </Button>
          </div>

          {hasTokens && filteredTokens.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardIssuance.workspace.noTokensMatch")}
            </p>
          ) : null}

          {view === "list" ? (
            <IssuanceTokenList tokens={filteredTokens} onCreate={startTokenCreation} />
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
                        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-border-default bg-[white]">
                          {token.imageUrl ? (
                            // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
                            <img
                              src={token.imageUrl}
                              alt={t("DashboardIssuance.workspace.tokenLogo", { name: token.name })}
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
                          <h3 className="truncate text-lg font-semibold leading-tight text-primary">
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

                    <div className="mt-6 grid grid-cols-2 gap-4">
                      <div className="min-w-0">
                        <p className="text-xs text-tertiary">
                          {t("DashboardIssuance.workspace.supply")}
                        </p>
                        <p className="mt-0.5 truncate text-sm font-medium text-primary">
                          {formatSupply(token.totalSupply, locale)}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-tertiary">
                          {t("DashboardIssuance.list.decimals")}
                        </p>
                        <p className="mt-0.5 truncate text-sm font-medium text-primary">
                          {token.decimals}
                        </p>
                      </div>
                    </div>

                    <div className="mt-auto flex items-end justify-between pt-4">
                      <div className="min-w-0">
                        <p className="text-xs text-tertiary">
                          {t("DashboardIssuance.workspace.created")}
                        </p>
                        <p className="mt-0.5 truncate text-sm font-medium text-primary">
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
                  {t("DashboardIssuance.workspace.createDraft")}
                </span>
              </button>
            </div>
          )}
        </>
      }
      playground={playgroundContent}
    />
  );
}
