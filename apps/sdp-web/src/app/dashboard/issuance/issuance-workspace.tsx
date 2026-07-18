"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Plus, Search } from "lucide-react";
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
import { getTemplateCatalogEntry, type IssuanceTemplateId } from "./template-catalog";

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

interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: IssuanceTemplateId | "rwa" | string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

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

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) {
    return "—";
  }

  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;
    return new Date(`${year}-${month}-${day}T00:00:00`).toLocaleDateString(locale);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(locale);
}

function formatSupply(value: string, locale: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "0";
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: parsed >= 100 ? 0 : 1,
  }).format(parsed);
}

function getTokenTypeLabel(
  template: IssuanceTokenView["template"],
  t: ReturnType<typeof useTranslations>
): string {
  const templateEntry = getTemplateCatalogEntry(template);
  if (templateEntry) {
    return t(`DashboardIssuance.templates.${templateEntry.nameKey}`);
  }

  return template;
}

function getDeploymentStatus(token: IssuanceTokenView): "draft" | "active" {
  return token.mintAddress || token.deployedAt ? "active" : "draft";
}

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
                className="h-10 rounded-[10px] border-border-default bg-white pl-9"
                placeholder={t("DashboardIssuance.workspace.search")}
              />
            </div>
            <Button
              type="button"
              className="h-10 rounded-[10px] bg-primary px-4 text-white hover:opacity-90"
              onClick={startTokenCreation}
            >
              {t("DashboardIssuance.workspace.createDraft")}
            </Button>
          </div>

          {hasTokens && filteredTokens.length === 0 ? (
            <p className="text-sm text-secondary">
              {t("DashboardIssuance.workspace.noTokensMatch")}
            </p>
          ) : null}

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
                      <div className="h-14 w-14 overflow-hidden rounded-full border border-border-default bg-white">
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
                    <span className="text-tertiary">{t("DashboardIssuance.workspace.supply")}</span>
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
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full rounded-[10px]"
                    asChild
                  >
                    <Link href={`/dashboard/issuance/${token.id}`}>
                      {t("DashboardIssuance.workspace.manage")}
                    </Link>
                  </Button>
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
