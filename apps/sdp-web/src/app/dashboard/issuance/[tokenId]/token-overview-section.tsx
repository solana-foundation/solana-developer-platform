"use client";

import type { Token } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatDisplayLabel } from "@/lib/utils";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import { formatDate } from "./token-management-workspace.utils";

interface TokenOverviewSectionProps {
  token: Token;
  showTitle?: boolean;
  mintAuthorityValue?: string | null;
  onRefreshSupply?: () => void;
  refreshDisabled?: boolean;
  refreshDisabledReason?: string | null;
}

export function TokenOverviewSection({
  token,
  showTitle = true,
  mintAuthorityValue,
  onRefreshSupply,
  refreshDisabled = false,
  refreshDisabledReason = null,
}: TokenOverviewSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section className="space-y-3">
      {showTitle || onRefreshSupply ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {showTitle ? (
            <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
              {t("DashboardIssuance.overview.title")}
            </h3>
          ) : (
            <div />
          )}
          {onRefreshSupply ? (
            <TokenDisabledActionTooltip reason={refreshDisabled ? refreshDisabledReason : null}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefreshSupply}
                disabled={refreshDisabled}
              >
                {t("DashboardIssuance.management.refreshSupply")}
              </Button>
            </TokenDisabledActionTooltip>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        <OverviewRow
          label={t("DashboardIssuance.overview.tokenAddress")}
          value={token.mintAddress ?? t("DashboardIssuance.header.notDeployed")}
          monospace
        />
        <OverviewRow
          label={t("DashboardIssuance.overview.mintAuthority")}
          value={mintAuthorityValue ?? t("DashboardIssuance.wallet.none")}
          monospace
        />
        <OverviewRow label={t("DashboardIssuance.overview.supply")} value={token.totalSupply} />
        <OverviewRow
          label={t("DashboardIssuance.transactions.created")}
          value={formatDate(token.createdAt, locale)}
        />
        <OverviewRow
          label={t("DashboardIssuance.overview.template")}
          value={formatDisplayLabel(token.template)}
        />
        <OverviewRow
          label={t("DashboardIssuance.create.decimals")}
          value={String(token.decimals)}
        />
      </div>
    </section>
  );
}

function OverviewRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div
      data-testid={`overview-row-${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}`}
      className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
    >
      <p className="text-[15px] text-secondary">{label}</p>
      <p
        className={[
          "text-right text-[15px] text-primary",
          monospace ? "font-mono text-xs" : "",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}
