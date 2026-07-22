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
import { IssuancePlaygroundLoading } from "./issuance-playground-loading";
import {
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenChips,
  type IssuanceTokenView,
  type TokenView,
} from "./issuance-token-fields";
import { IssuanceTokenList, ManageKebab } from "./issuance-token-list";

// Draft creation is a full-page wizard (V2 issuance direction) gated behind the
// Asset Profiles UI flag. When the flag is off we fall back to the legacy
// create-token-modal.tsx so token creation still works.
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

  const filteredTokens = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return tokens;
    }

    return tokens.filter((token) => {
      return (
        token.name.toLowerCase().includes(needle) ||
        token.symbol.toLowerCase().includes(needle) ||
        token.id.toLowerCase().includes(needle) ||
        (token.mintAddress ? token.mintAddress.toLowerCase().includes(needle) : false)
      );
    });
  }, [tokens, search]);
  const hasTokens = tokens.length > 0;

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
            <div className="flex-1">
              <Input
                value={search}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSearch(value);
                }}
                className="h-10 rounded-[10px] border-border-default bg-surface-raised"
                placeholder={t("DashboardIssuance.workspace.search")}
                iconLeft={<Search />}
              />
            </div>
            {/* Grid ⇄ list toggle — icon-only. Custom control because the design
                system's SegmentedControl always renders a visible label. Radius
                matches the search field and Create-draft button (rounded-[10px]). */}
            <div className="inline-flex h-10 shrink-0 items-center gap-1 rounded-[10px] border border-border-default bg-fill-subtle p-1">
              {[
                {
                  value: "grid" as const,
                  label: t("DashboardIssuance.workspace.viewGrid"),
                  icon: <LayoutGrid className="h-4 w-4" />,
                },
                {
                  value: "list" as const,
                  label: t("DashboardIssuance.workspace.viewList"),
                  icon: <List className="h-4 w-4" />,
                },
              ].map((item) => {
                const active = view === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-label={item.label}
                    aria-pressed={active}
                    onClick={() => changeView(item.value)}
                    className={[
                      "inline-flex h-full w-8 items-center justify-center rounded-md border transition-colors",
                      active
                        ? "border-border-default bg-surface-raised text-primary"
                        : "border-transparent text-tertiary hover:text-secondary",
                    ].join(" ")}
                  >
                    {item.icon}
                  </button>
                );
              })}
            </div>
            <Button
              type="button"
              className="h-10 rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90"
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
                    className="relative flex min-h-[240px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 transition-colors hover:border-border-strong"
                  >
                    {/* The whole tile navigates to the asset management page via a
                        full-bleed overlay link; the kebab sits above it (z-10) so
                        its menu stays independently clickable. */}
                    <Link
                      href={`/dashboard/issuance/${token.id}`}
                      aria-label={t("DashboardIssuance.workspace.manageAsset", {
                        name: token.name,
                      })}
                      className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
                    />
                    {/* Header: avatar + symbol/name inline, status pinned right. */}
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

                    {/* Classification chips (category + subtype). */}
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

                    {/* Supply / Decimals stat pair. */}
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

                    {/* Footer: Created (left) + kebab (right) — mockup's bottom row,
                        keeping the ⋯ menu instead of the arrow. */}
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

          {assetProfilesUiEnabled ? null : (
            <CreateIssuanceTokenModal
              open={isCreateTokenModalOpen}
              onOpenChange={setIsCreateTokenModalOpen}
              signerWallets={signerWallets}
              signerWalletsError={signerWalletsError}
              hideTrigger
            />
          )}
        </>
      }
      playground={
        <IssuancePlayground
          apiBaseUrl={apiBaseUrl}
          apiKeyValue={playgroundApiKeyValue}
          hasActiveApiKeys={apiKeys.length > 0}
          templates={templates}
          templatesError={templatesError}
          tokens={tokens}
        />
      }
    />
  );
}
