"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
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
  type FieldDepth,
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenTypeLabel,
  type IssuanceTokenView,
  type ManageVariant,
  type TokenView,
} from "./issuance-token-fields";
import { IssuanceTokenList, ManageAffordance } from "./issuance-token-list";

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

// localStorage keys for the view toggle + temporary preview toggles.
const VIEW_STORAGE_KEY = "sdp.issuance.tokenView";
const MANAGE_VARIANT_STORAGE_KEY = "sdp.issuance.manageVariant";
const FIELD_DEPTH_STORAGE_KEY = "sdp.issuance.fieldDepth";

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

  // Grid ⇄ list view (persisted). The `manageVariant` / `fieldDepth` state are
  // TEMPORARY preview toggles so the reviewer can compare all Manage affordances
  // and both field-depth modes; remove them (and the dev bar below) once a single
  // variant of each is chosen.
  const [view, setView] = useState<TokenView>("grid");
  const [manageVariant, setManageVariant] = useState<ManageVariant>("link");
  const [fieldDepth, setFieldDepth] = useState<FieldDepth>("type-aware");

  useEffect(() => {
    try {
      const storedView = localStorage.getItem(VIEW_STORAGE_KEY);
      if (storedView === "grid" || storedView === "list") {
        setView(storedView);
      }
      const storedManage = localStorage.getItem(MANAGE_VARIANT_STORAGE_KEY);
      if (storedManage === "link" || storedManage === "kebab" || storedManage === "button") {
        setManageVariant(storedManage);
      }
      const storedDepth = localStorage.getItem(FIELD_DEPTH_STORAGE_KEY);
      if (storedDepth === "type-aware" || storedDepth === "core") {
        setFieldDepth(storedDepth);
      }
    } catch {
      // Ignore storage access errors (private mode, etc.).
    }
  }, []);

  const persist = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore.
    }
  };
  const changeView = (next: TokenView) => {
    setView(next);
    persist(VIEW_STORAGE_KEY, next);
  };
  const changeManageVariant = (next: ManageVariant) => {
    setManageVariant(next);
    persist(MANAGE_VARIANT_STORAGE_KEY, next);
  };
  const changeFieldDepth = (next: FieldDepth) => {
    setFieldDepth(next);
    persist(FIELD_DEPTH_STORAGE_KEY, next);
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
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-tertiary" />
              <Input
                value={search}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSearch(value);
                }}
                className="h-10 rounded-[10px] border-border-default bg-surface-raised pl-9"
                placeholder={t("DashboardIssuance.workspace.search")}
              />
            </div>
            <div className="w-[176px] shrink-0">
              <SegmentedControl
                aria-label={t("DashboardIssuance.workspace.viewToggleLabel")}
                value={view}
                onValueChange={(value) => changeView(value as TokenView)}
                items={[
                  {
                    value: "grid",
                    label: t("DashboardIssuance.workspace.viewGrid"),
                    icon: <LayoutGrid className="h-4 w-4" />,
                  },
                  {
                    value: "list",
                    label: t("DashboardIssuance.workspace.viewList"),
                    icon: <List className="h-4 w-4" />,
                  },
                ]}
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

          {/* TEMP: preview toggles — lets the reviewer compare all Manage
              affordances and both field-depth modes. Remove this whole block
              (and the manageVariant / fieldDepth state) once a variant is chosen. */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-dashed border-border-strong bg-fill-subtle px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {t("DashboardIssuance.list.devPreview")}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary">
                {t("DashboardIssuance.list.devManageStyle")}
              </span>
              <div className="w-[280px]">
                <SegmentedControl
                  aria-label={t("DashboardIssuance.list.devManageStyle")}
                  value={manageVariant}
                  onValueChange={(value) => changeManageVariant(value as ManageVariant)}
                  items={[
                    { value: "link", label: t("DashboardIssuance.list.manageLink") },
                    { value: "kebab", label: t("DashboardIssuance.list.manageKebab") },
                    { value: "button", label: t("DashboardIssuance.list.manageButton") },
                  ]}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary">
                {t("DashboardIssuance.list.devFieldDepth")}
              </span>
              <div className="w-[240px]">
                <SegmentedControl
                  aria-label={t("DashboardIssuance.list.devFieldDepth")}
                  value={fieldDepth}
                  onValueChange={(value) => changeFieldDepth(value as FieldDepth)}
                  items={[
                    { value: "type-aware", label: t("DashboardIssuance.list.depthTypeAware") },
                    { value: "core", label: t("DashboardIssuance.list.depthCore") },
                  ]}
                />
              </div>
            </div>
          </div>

          {hasTokens && filteredTokens.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardIssuance.workspace.noTokensMatch")}
            </p>
          ) : null}

          {view === "list" ? (
            <IssuanceTokenList
              tokens={filteredTokens}
              manageVariant={manageVariant}
              fieldDepth={fieldDepth}
              onCreate={startTokenCreation}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredTokens.map((token) => (
                <article
                  key={token.id}
                  data-testid={`token-card-${token.id}`}
                  className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]"
                >
                  {(() => {
                    const deploymentStatus = getDeploymentStatus(token);

                    return (
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
                    );
                  })()}
                  <p className="text-sm font-medium tracking-wide text-tertiary">{token.symbol}</p>
                  <h3 className="mt-1 text-[30px] leading-[1.1] font-medium text-primary">
                    {token.name}
                  </h3>

                  <div className="mt-6 space-y-2 rounded-xl border border-border-subtle bg-fill-subtle p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-tertiary">{t("DashboardIssuance.workspace.type")}</span>
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

                  <div className="mt-auto flex items-center justify-end pt-3">
                    <ManageAffordance token={token} variant={manageVariant} context="tile" />
                  </div>
                </article>
              ))}

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
