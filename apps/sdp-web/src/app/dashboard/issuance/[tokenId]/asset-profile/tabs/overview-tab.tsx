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
  Wallet,
} from "lucide-react";
import { cn, formatDisplayLabel } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../../create/asset-taxonomy";
import { getAssetDetailsErrors, safeLinkHref } from "../../../create/draft-mapping";
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
  onDeploy,
}: {
  token: Token;
  assetProfile: AssetProfile;
  draft: DraftState;
  ops: TokenOperations;
  onDeploy: () => void;
}) {
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const deployBlockers = ops.canDeployToken ? Object.values(getAssetDetailsErrors(draft)) : [];
  const website = draft.website.trim();
  const websiteHref = safeLinkHref(website);

  return (
    <div className="space-y-4">
      {/* Identity hero — same grammar as the creation flow's public preview */}
      <div className="rounded-2xl border border-border-default bg-white p-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex min-w-0 flex-col">
            <p
              className={
                token.description
                  ? "max-w-prose text-[13px] leading-relaxed text-secondary"
                  : "text-[13px] text-muted"
              }
            >
              {token.description || "No description yet — add one in the Details tab."}
            </p>
            <IdentityFields
              website={website}
              websiteHref={websiteHref}
              mintAddress={token.mintAddress}
              onCopy={(value) => void ops.handleCopy(value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-0 md:border-l md:border-border-subtle md:pl-5">
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
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary disabled:pointer-events-none disabled:opacity-50"
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
          <div className="grid overflow-hidden rounded-2xl border border-border-default bg-white sm:grid-cols-2 sm:divide-x sm:divide-border-subtle">
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
          deployBlockers.length > 0 ? (
            <div className="rounded-2xl border border-border-default bg-white p-4">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4.5 w-4.5 shrink-0 text-warning" />
                <p className="text-[15px] font-semibold text-primary">Ready for deploy</p>
              </div>
              <ul className="mt-2 space-y-1">
                {deployBlockers.map((blocker) => (
                  <li key={blocker} className="text-[13px] leading-relaxed text-warning">
                    {blocker}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <button
              type="button"
              onClick={onDeploy}
              className="group flex cursor-pointer flex-col rounded-2xl border border-border-default bg-white p-4 text-left transition-colors hover:border-border-strong hover:bg-fill-subtle"
            >
              <div className="flex items-center gap-2">
                <CircleCheck className="h-4.5 w-4.5 shrink-0 text-success" />
                <p className="text-[15px] font-semibold text-primary">Ready for deploy</p>
                <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-primary" />
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-secondary">
                This asset is ready to deploy — continue in the Operations tab.
              </p>
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function IdentityFields({
  website,
  websiteHref,
  mintAddress,
  onCopy,
}: {
  website: string;
  websiteHref: string | undefined;
  mintAddress: string | null;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 md:mt-auto">
      {website ? (
        <div>
          <div className="flex items-center gap-1.5 text-tertiary">
            <Globe className="h-3 w-3 shrink-0" />
            <span className="text-[11px]">Website</span>
          </div>
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-[13px] font-medium text-primary hover:underline"
            >
              <span className="truncate">{website}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <p className="mt-0.5 truncate text-[13px] font-medium text-secondary">{website}</p>
          )}
        </div>
      ) : null}
      <div>
        <div className="flex items-center gap-1.5 text-tertiary">
          <Wallet className="h-3 w-3 shrink-0" />
          <span className="text-[11px]">Mint address</span>
        </div>
        {mintAddress ? (
          <div className="mt-0.5 flex w-fit max-w-full items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium text-primary">
              {mintAddress}
            </span>
            <button
              type="button"
              onClick={() => onCopy(mintAddress)}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary"
              aria-label="Copy token address"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p className="mt-0.5 text-[13px] text-muted">Not deployed yet</p>
        )}
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
    <div className={cn("px-3 py-2.5", className)}>
      <div className="flex items-center gap-1.5 text-tertiary">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      <p
        className={cn(
          "mt-0.5 truncate text-[13px] font-medium",
          hasValue ? "text-primary" : "text-muted"
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
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-primary">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-primary">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-secondary">{description}</p>
      </div>
    </div>
  );
}
