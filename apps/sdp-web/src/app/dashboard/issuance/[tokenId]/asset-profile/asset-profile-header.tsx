"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ArrowUpRight, Copy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../create/asset-taxonomy";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";

const STATUS_BADGES: Record<Token["status"], { label: string; className: string }> = {
  pending: {
    label: "Draft",
    className: "border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.04)] text-[rgba(28,28,29,0.66)]",
  },
  active: {
    label: "Active",
    className: "border-[rgba(12,128,76,0.24)] bg-[rgba(12,128,76,0.08)] text-[#0c804c]",
  },
  paused: {
    label: "Paused",
    className: "border-[rgba(217,119,6,0.28)] bg-[rgba(245,158,11,0.1)] text-[#92400e]",
  },
  revoked: {
    label: "Revoked",
    className: "border-[rgba(199,31,55,0.24)] bg-[rgba(199,31,55,0.06)] text-[#8a1f2a]",
  },
};

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
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const status = STATUS_BADGES[token.status];
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
            alt={`${token.name} logo`}
            className="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-black/5"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3a3a3d] to-[#0f0f10] text-2xl font-semibold text-white ring-1 ring-black/5">
            {token.symbol.slice(0, 1).toUpperCase() || "?"}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate text-[32px] leading-[1.05] font-semibold tracking-[-0.4px] text-[#1c1c1d]">
              {token.name}
            </h2>
            <span className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-2.5 py-0.5 text-sm font-medium text-[rgba(28,28,29,0.7)]">
              {token.symbol}
            </span>
            <span
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-sm font-medium",
                status.className
              )}
            >
              {status.label}
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {category ? <ClassificationChip icon={category.icon} label={category.label} /> : null}
            {subType ? <ClassificationChip icon={subType.icon} label={subType.label} /> : null}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[rgba(28,28,29,0.55)]">
            {addressLabel ? (
              <span className="inline-flex items-center gap-1">
                {addressLabel}
                <button
                  type="button"
                  onClick={onCopyAddress}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[rgba(28,28,29,0.5)] transition-colors hover:bg-[rgba(28,28,29,0.05)] hover:text-[#1c1c1d]"
                  aria-label="Copy token address"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1" data-testid="token-id-row">
              {token.id}
              <button
                type="button"
                onClick={onCopyTokenId}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[rgba(28,28,29,0.5)] transition-colors hover:bg-[rgba(28,28,29,0.05)] hover:text-[#1c1c1d]"
                aria-label="Copy token ID"
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
              Explorer
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}

        {canDeployToken ? (
          <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
            <Button
              type="button"
              onClick={onDeploy}
              disabled={isPending || Boolean(deployDisabledReason)}
            >
              Deploy
            </Button>
          </TokenDisabledActionTooltip>
        ) : token.status === "paused" && canManageTokenAdmin ? (
          <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
            <Button
              type="button"
              onClick={onUnpause}
              disabled={isPending || Boolean(pauseDisabledReason)}
            >
              Unpause
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(28,28,29,0.12)] bg-white px-3 py-1 text-[13px] font-medium text-[rgba(28,28,29,0.72)]">
      <Icon className="h-3.5 w-3.5 text-[rgba(28,28,29,0.5)]" />
      {label}
    </span>
  );
}
