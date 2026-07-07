"use client";

import type { AssetProfile, Token } from "@sdp/types";
import {
  Activity,
  ArrowUpRight,
  CircleCheck,
  Clock,
  Coins,
  Copy,
  Globe,
  Hash,
  KeyRound,
  Layers,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { cn, formatDisplayLabel } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../../create/asset-taxonomy";
import { getAssetDetailsErrors } from "../../../create/draft-mapping";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { formatDate } from "../../token-management-workspace.utils";
import type { TokenOperations } from "../use-token-operations";

const STATUS_LABELS: Record<Token["status"], string> = {
  pending: "Draft",
  active: "Active",
  paused: "Paused",
  revoked: "Revoked",
};

export function OverviewTab({
  token,
  assetProfile,
  draft,
  ops,
}: {
  token: Token;
  assetProfile: AssetProfile;
  draft: DraftState;
  ops: TokenOperations;
}) {
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const deployBlockers = ops.canDeployToken ? Object.values(getAssetDetailsErrors(draft)) : [];
  const website = draft.website.trim();

  return (
    <div className="space-y-4">
      {/* Identity hero — same grammar as the creation flow's public preview */}
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="min-w-0">
            <p
              className={
                token.description
                  ? "max-w-prose text-[13px] leading-relaxed text-[rgba(28,28,29,0.62)]"
                  : "text-[13px] text-[rgba(28,28,29,0.4)]"
              }
            >
              {token.description || "No description yet — add one in the Details tab."}
            </p>
            {website ? (
              <a
                href={website}
                target="_blank"
                rel="noreferrer"
                className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] font-medium text-[#1c1c1d] hover:underline"
              >
                <Globe className="h-3.5 w-3.5 text-[rgba(28,28,29,0.5)]" />
                {website}
                <ArrowUpRight className="h-3 w-3 shrink-0" />
              </a>
            ) : null}
            {token.mintAddress ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-[rgba(28,28,29,0.72)]">
                  {token.mintAddress}
                </span>
                <button
                  type="button"
                  onClick={() => void ops.handleCopy(token.mintAddress)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[rgba(28,28,29,0.5)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]"
                  aria-label="Copy token address"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-[rgba(28,28,29,0.14)] px-3 py-2 text-[13px] text-[rgba(28,28,29,0.5)]">
                Not deployed yet — no on-chain address.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5 md:border-l md:border-[rgba(28,28,29,0.08)] md:pl-5">
            <StatTile icon={Activity} label="Status" value={STATUS_LABELS[token.status]} />
            <StatTile
              icon={Coins}
              label="Total supply"
              value={token.totalSupply}
              action={
                token.status !== "pending" ? (
                  <button
                    type="button"
                    onClick={ops.handleRefreshSupply}
                    disabled={ops.isPending}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[rgba(28,28,29,0.5)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d] disabled:pointer-events-none disabled:opacity-50"
                    aria-label="Refresh supply"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                ) : null
              }
            />
            <StatTile icon={Hash} label="Decimals" value={String(token.decimals)} />
            <StatTile icon={Clock} label="Created" value={formatDate(token.createdAt)} />
            <StatTile icon={Layers} label="Template" value={formatDisplayLabel(token.template)} />
            <StatTile
              icon={KeyRound}
              label="Mint authority"
              value={
                ops.displayedMintAuthority
                  ? `${ops.displayedMintAuthority.slice(0, 5)}…${ops.displayedMintAuthority.slice(-4)}`
                  : "None"
              }
            />
          </div>
        </div>
      </div>

      {/* Classification — category + asset type share one card so the row
          stays balanced once the deploy-readiness tile drops off post-deploy.
          Pre-deploy, readiness sits beside it as a third column. */}
      <div
        className={cn(
          "grid gap-3",
          ops.canDeployToken ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : undefined
        )}
      >
        {category || subType ? (
          <div className="grid overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white sm:grid-cols-2 sm:divide-x sm:divide-[rgba(28,28,29,0.08)]">
            {category ? (
              <ClassificationCell
                icon={category.icon}
                title={category.label}
                description={category.description}
              />
            ) : null}
            {subType ? (
              <ClassificationCell
                icon={subType.icon}
                title={subType.label}
                description={subType.description}
              />
            ) : null}
          </div>
        ) : null}
        {ops.canDeployToken ? (
          <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-4">
            <div className="flex items-center gap-2">
              {deployBlockers.length > 0 ? (
                <TriangleAlert className="h-4.5 w-4.5 shrink-0 text-[#92400e]" />
              ) : (
                <CircleCheck className="h-4.5 w-4.5 shrink-0 text-[#0c804c]" />
              )}
              <p className="text-[15px] font-semibold text-[#1c1c1d]">Deploy readiness</p>
            </div>
            {deployBlockers.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {deployBlockers.map((blocker) => (
                  <li key={blocker} className="text-[13px] leading-relaxed text-[#92400e]">
                    {blocker}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] leading-relaxed text-[rgba(28,28,29,0.62)]">
                This asset is ready to deploy from the Operations tab.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  action,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  action?: React.ReactNode;
  className?: string;
}) {
  const hasValue = value !== null && value.trim().length > 0;
  return (
    <div
      className={cn(
        "rounded-lg border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-3 py-2.5",
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-[rgba(28,28,29,0.5)]">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      <p
        className={cn(
          "mt-0.5 truncate text-[13px] font-medium",
          hasValue ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.4)]"
        )}
      >
        {hasValue ? value : "—"}
      </p>
    </div>
  );
}

function ClassificationCell({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-[#1c1c1d]">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-[rgba(28,28,29,0.62)]">{description}</p>
      </div>
    </div>
  );
}
