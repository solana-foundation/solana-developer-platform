"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ArrowUpRight, Copy, Play, Rocket } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../create/asset-taxonomy";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";

// SDP design-system badge tokens (sdp-design-system.css): .badge-gray,
// .badge-green, .badge-amber, .badge-red — tinted fill + semantic text, no border.
// Decorated header in the asset-profile design language: logo avatar,
// classification chips with taxonomy icons, quiet identity rows.
export function AssetProfileHeader({
  token,
  assetProfile,
  explorerHref,
  canDeployToken,
  canManageTokenAdmin,
  isPending,
  deployDisabledReason,
  pauseDisabledReason,
  onCopyAddress,
  onCopyTokenId,
  onDeploy,
  onUnpause,
}: {
  token: Token;
  assetProfile: AssetProfile;
  explorerHref: string | null;
  canDeployToken: boolean;
  canManageTokenAdmin: boolean;
  isPending: boolean;
  deployDisabledReason?: string | null;
  pauseDisabledReason?: string | null;
  onCopyAddress: () => void;
  onCopyTokenId: () => void;
  onDeploy: () => void;
  onUnpause: () => void;
}) {
  const t = useTranslations();
  const statusBadges: Record<Token["status"], { label: string; className: string }> = {
    pending: {
      label: t("DashboardIssuance.status.draft"),
      className: "bg-fill text-secondary",
    },
    active: {
      label: t("DashboardIssuance.status.active"),
      className: "bg-success-bg text-success",
    },
    paused: {
      label: t("DashboardIssuance.status.paused"),
      className: "bg-warning-bg text-warning",
    },
    revoked: {
      label: t("DashboardIssuance.status.revoked"),
      className: "bg-error-bg text-error",
    },
  };
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const status = statusBadges[token.status];
  const addressLabel = token.mintAddress
    ? `${token.mintAddress.slice(0, 5)}…${token.mintAddress.slice(-4)}`
    : null;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        {token.imageUrl ? (
          // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
          <img
            src={token.imageUrl}
            alt={t("DashboardIssuance.header.tokenLogo", { name: token.name })}
            className="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-black/5"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary text-2xl font-semibold text-on-primary ring-1 ring-black/5">
            {token.symbol.slice(0, 1).toUpperCase() || "?"}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-primary">
              {token.name}
            </h2>
            <span className="rounded-full bg-fill px-2.5 py-0.5 text-sm font-medium text-secondary">
              {token.symbol}
            </span>
            <span
              className={cn("rounded-full px-2.5 py-0.5 text-sm font-medium", status.className)}
            >
              {status.label}
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {category ? (
              <ClassificationChip icon={category.icon} label={t(category.labelKey)} />
            ) : null}
            {subType ? (
              <ClassificationChip icon={subType.icon} label={t(subType.labelKey)} />
            ) : null}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-tertiary">
            {addressLabel ? (
              <span className="inline-flex items-center gap-1">
                {addressLabel}
                <button
                  type="button"
                  onClick={onCopyAddress}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                  aria-label={t("DashboardIssuance.header.copyTokenAddress")}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : null}
            <span
              className="inline-flex min-w-0 max-w-full items-center gap-1"
              data-testid="token-id-row"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]" data-token-id-value>
                {token.id}
              </span>
              <button
                type="button"
                onClick={onCopyTokenId}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                aria-label={t("DashboardIssuance.header.copyTokenId")}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {explorerHref ? (
          <Button variant="outline" asChild>
            <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
              {t("DashboardIssuance.header.explorer")}
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}

        {canDeployToken ? (
          <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
            <Button
              type="button"
              iconLeft={<Rocket />}
              onClick={onDeploy}
              disabled={isPending || Boolean(deployDisabledReason)}
            >
              {t("DashboardIssuance.header.deploy")}
            </Button>
          </TokenDisabledActionTooltip>
        ) : token.status === "paused" && canManageTokenAdmin ? (
          <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
            <Button
              type="button"
              iconLeft={<Play />}
              onClick={onUnpause}
              disabled={isPending || Boolean(pauseDisabledReason)}
            >
              {t("DashboardIssuance.header.unpause")}
            </Button>
          </TokenDisabledActionTooltip>
        ) : null}
      </div>
    </div>
  );
}

function ClassificationChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-surface-raised px-3 py-1 text-[13px] font-medium text-secondary">
      <Icon className="h-3.5 w-3.5 text-tertiary" />
      {label}
    </span>
  );
}
