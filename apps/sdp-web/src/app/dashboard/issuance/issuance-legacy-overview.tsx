"use client";

import { Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  deploymentStatusBadge,
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenTypeLabel,
  type IssuanceTokenView,
} from "./issuance-token-fields";

// The asset overview as it looked before the Asset Profiles UI: a plain card grid
// with a Type/Supply/Created stat box and a Manage link — no classification chips,
// filter popover, view toggle or kebab. Still rendered when the flag is off.
//
// Search and paging are the same server-driven state as the new overview; only
// the presentation is frozen.

interface IssuanceLegacyOverviewProps {
  tokens: IssuanceTokenView[];
  search: string;
  onSearchChange: (value: string) => void;
  onCreate: () => void;
  /** Dim the rows while the next page is in flight. */
  isRefreshing: boolean;
  tokensNotice: string | null;
  emptyResultsNotice: ReactNode;
  pagination: ReactNode;
  createModal: ReactNode;
}

export function IssuanceLegacyOverview({
  tokens,
  search,
  onSearchChange,
  onCreate,
  isRefreshing,
  tokensNotice,
  emptyResultsNotice,
  pagination,
  createModal,
}: IssuanceLegacyOverviewProps) {
  const t = useTranslations();
  const locale = useLocale();

  return (
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
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            className="h-10 rounded-[10px] border-border-default bg-surface-raised pl-9"
            placeholder={t("DashboardIssuance.workspace.search")}
          />
        </div>
        <Button
          type="button"
          className="h-10 rounded-[10px] bg-primary px-4 text-on-primary hover:opacity-90"
          onClick={onCreate}
        >
          {t("DashboardIssuance.workspace.createDraft")}
        </Button>
      </div>

      {emptyResultsNotice}

      <div
        aria-busy={isRefreshing}
        className={cn(
          "grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3",
          isRefreshing && "opacity-60"
        )}
      >
        {tokens.map((token) => {
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
                  className={cn(
                    "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium tracking-[0.02em] capitalize",
                    deploymentStatusBadge(deploymentStatus, t).badge
                  )}
                >
                  {deploymentStatusBadge(deploymentStatus, t).label}
                </span>
              </div>
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
                  <span className="text-tertiary">{t("DashboardIssuance.workspace.created")}</span>
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
          onClick={onCreate}
          data-testid="token-add-card"
          className="flex min-h-[340px] items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
          aria-label={t("DashboardIssuance.workspace.addNewToken")}
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>

      {pagination}

      {createModal}
    </>
  );
}
