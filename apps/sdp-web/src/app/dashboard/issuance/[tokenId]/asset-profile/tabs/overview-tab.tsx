"use client";

import { Popover } from "@base-ui/react/popover";
import type { AssetProfile, Token } from "@sdp/types";
import {
  Activity,
  ArrowUpRight,
  Clock,
  Coins,
  Copy,
  Globe,
  Hash,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { cn } from "@/lib/utils";
import { getCategoryPresentation, getSubTypePresentation } from "../../../create/asset-taxonomy";
import { safeLinkHref } from "../../../create/draft-mapping";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { formatDate, formatDateTime } from "../../token-management-workspace.utils";
import { fetchAssetAuditHistory } from "../asset-audit.data";
import {
  auditActionIcon,
  auditActionLabel,
  auditActorBadgeClass,
  auditActorTypeLabel,
} from "../asset-audit-presentation";
import type { TokenOperations } from "../use-token-operations";

export function OverviewTab({
  token,
  assetProfile,
  draft,
  ops,
  onViewActivity,
  onViewPermissions,
}: {
  token: Token;
  assetProfile: AssetProfile;
  draft: DraftState;
  ops: TokenOperations;
  onViewActivity: () => void;
  onViewPermissions: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const statusLabels: Record<Token["status"], string> = {
    pending: t("DashboardIssuance.status.draft"),
    active: t("DashboardIssuance.status.active"),
    paused: t("DashboardIssuance.status.paused"),
    revoked: t("DashboardIssuance.status.revoked"),
  };
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);
  const website = draft.website.trim();
  const websiteHref = safeLinkHref(website);

  return (
    <div className="space-y-4">
      {/* Identity hero — same grammar as the creation flow's public preview */}
      <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
        <div className="grid gap-4 md:grid-cols-2 md:gap-5">
          <div className="flex min-w-0 flex-col">
            <p
              className={
                token.description
                  ? "max-w-prose text-[13px] leading-relaxed text-secondary"
                  : "text-[13px] text-muted"
              }
            >
              {token.description || t("DashboardIssuance.overview.noDescription")}
            </p>
            <IdentityFields
              website={website}
              websiteHref={websiteHref}
              mintAddress={token.mintAddress}
              onCopy={(value) => void ops.handleCopy(value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-x-4 md:gap-0 md:border-l md:border-border-subtle md:pl-5">
            <StatTile
              icon={Activity}
              label={t("DashboardIssuance.transactions.status")}
              value={statusLabels[token.status]}
            />
            <StatTile
              icon={Coins}
              label={t("DashboardIssuance.overview.totalSupply")}
              value={token.totalSupply}
              action={
                token.status !== "pending" ? (
                  <button
                    type="button"
                    onClick={ops.handleRefreshSupply}
                    disabled={ops.isPending}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                    aria-label={t("DashboardIssuance.management.refreshSupply")}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                ) : null
              }
            />
            <StatTile
              icon={Hash}
              label={t("DashboardIssuance.create.decimals")}
              value={String(token.decimals)}
            />
            <StatTile
              icon={Clock}
              label={t("DashboardIssuance.transactions.created")}
              value={formatDate(token.createdAt, locale)}
            />
            <StatTile
              icon={KeyRound}
              label={t("DashboardIssuance.overview.mintAuthority")}
              value={
                ops.displayedMintAuthority
                  ? `${ops.displayedMintAuthority.slice(0, 5)}…${ops.displayedMintAuthority.slice(-4)}`
                  : t("DashboardIssuance.wallet.none")
              }
            />
            <StatTile
              icon={ShieldCheck}
              label={t("DashboardIssuance.overview.authoritiesControlled")}
              value={
                ops.authoritySummary.known
                  ? `${ops.authoritySummary.controlled} / ${ops.authoritySummary.total}`
                  : null
              }
              valueAdornment={
                ops.authoritySummary.known &&
                ops.authoritySummary.controlled < ops.authoritySummary.total ? (
                  <ManagedAuthoritiesWarning onViewPermissions={onViewPermissions} />
                ) : null
              }
            />
          </div>
        </div>
      </div>

      {/* Classification (category + asset type) stacked in one column beside a
          wider recent-activity preview. Grid stretch keeps both the same height. */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        {category || subType ? (
          <div className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
            {category ? (
              <ClassificationCell
                icon={category.icon}
                title={t(category.labelKey)}
                description={t(category.descriptionKey)}
              />
            ) : null}
            {subType ? (
              <ClassificationCell
                icon={subType.icon}
                title={t(subType.labelKey)}
                description={t(subType.descriptionKey)}
              />
            ) : null}
          </div>
        ) : null}
        <RecentActivityCard tokenId={token.id} onViewAll={onViewActivity} />
      </div>
    </div>
  );
}

function RecentActivityCard({ tokenId, onViewAll }: { tokenId: string; onViewAll: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const { data, isLoading } = usePersistedDashboardSWR(
    ["asset-audit-recent", tokenId] as const,
    ([, id]) => fetchAssetAuditHistory(id, { pageSize: 3 }),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${tokenId}.audit.recent`, ttlMs: 30_000 }
  );
  const events = data?.events ?? [];

  return (
    <div className="@container flex h-full flex-col rounded-2xl border border-border-default bg-surface-raised px-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-semibold text-primary">
          {t("DashboardIssuance.activity.recentTitle")}
        </p>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
        >
          {t("DashboardIssuance.activity.viewAll")}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {isLoading && events.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-muted">{t("DashboardIssuance.activity.loading")}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-muted">{t("DashboardIssuance.activity.empty")}</p>
          </div>
        ) : (
          // Narrow card: two rows per event (badge/time, then actor/type — both
          // space-between). Wide card (@xl, container-query on the card itself so
          // it also triggers inside the lg two-column grid): shared column tracks
          // (subgrid) so pills, actor, badge and time line up across every row.
          <ul className="grid min-h-0 flex-1 auto-rows-fr @xl:grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] @xl:gap-x-3">
            {events.map((event) => {
              const ActionIcon = auditActionIcon(event.action);
              return (
                <li
                  key={event.id}
                  className="flex flex-col justify-center gap-2 border-t border-border-subtle py-3 first:border-t-0 @xl:col-span-full @xl:grid @xl:grid-cols-subgrid @xl:items-center @xl:justify-normal @xl:gap-x-3"
                >
                  <div className="flex items-center justify-between gap-2 @xl:contents">
                    <span className="inline-flex w-fit min-w-0 items-center gap-1.5 rounded-md bg-fill-subtle px-2 py-1 text-[12px] font-medium text-secondary @xl:col-start-1 @xl:row-start-1 @xl:justify-self-start">
                      <ActionIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{auditActionLabel(event.action)}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-tertiary tabular-nums @xl:col-start-4 @xl:row-start-1 @xl:justify-self-end">
                      {formatDateTime(event.createdAt, locale)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 @xl:contents">
                    <p className="min-w-0 truncate text-[12px] text-tertiary @xl:col-start-2 @xl:row-start-1">
                      {event.actorLabel}
                    </p>
                    <span
                      className={`inline-flex w-fit shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium @xl:col-start-3 @xl:row-start-1 @xl:justify-self-end ${auditActorBadgeClass(
                        event.actorType
                      )}`}
                    >
                      {auditActorTypeLabel(event.actorType, t)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
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
  const t = useTranslations();
  return (
    <div className="mt-4 flex flex-col gap-3 md:mt-auto">
      {website ? (
        <div>
          <div className="flex items-center gap-1.5 text-tertiary">
            <Globe className="h-3 w-3 shrink-0" />
            <span className="text-[11px]">{t("DashboardIssuance.assetDetails.website")}</span>
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
          <span className="text-[11px]">{t("DashboardIssuance.overview.mintAddress")}</span>
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
              aria-label={t("DashboardIssuance.header.copyTokenAddress")}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p className="mt-0.5 text-[13px] text-muted">
            {t("DashboardIssuance.overview.notDeployedYet")}
          </p>
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
  valueAdornment,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  action?: React.ReactNode;
  valueAdornment?: React.ReactNode;
  className?: string;
}) {
  const hasValue = value !== null && value.trim().length > 0;
  return (
    // Full-height flex column so the value bottom-aligns across a grid row even
    // when a neighbouring tile's label wraps to two lines (values stay aligned
    // regardless of label length / locale).
    <div className={cn("flex h-full flex-col py-2.5 md:px-3", className)}>
      <div className="flex items-center gap-1.5 text-tertiary">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-[11px]">{label}</span>
        {action ? <span className="-my-1 ml-1">{action}</span> : null}
      </div>
      <div className="mt-auto flex items-center gap-1.5 pt-0.5">
        <p
          className={cn(
            "min-w-0 truncate text-[13px] font-medium",
            hasValue ? "text-primary" : "text-muted"
          )}
        >
          {hasValue ? value : "—"}
        </p>
        {valueAdornment}
      </div>
    </div>
  );
}

// Amber warning surfaced beside the "Managed authorities" count when not every
// authority is SDP-managed. Hover/focus opens an interactive popover (Base UI
// popover stays open while hovering its content, unlike a tooltip) so the link
// through to the Permissions tab — where the full remediation guidance lives —
// is clickable.
function ManagedAuthoritiesWarning({ onViewPermissions }: { onViewPermissions: () => void }) {
  const t = useTranslations();
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={120}
        closeDelay={160}
        aria-label={t("DashboardIssuance.overview.authoritiesIncompleteTooltip")}
        className="inline-flex shrink-0 items-center justify-center rounded text-warning outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"
      >
        <TriangleAlert className="h-4 w-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="center" sideOffset={8} className="z-50">
          {/* Opaque surface base under the translucent amber tint so page content
              behind the portalled popover doesn't show through. */}
          <Popover.Popup className="max-w-[240px] overflow-hidden rounded-xl border border-warning-border bg-surface-raised outline-none">
            <div className="bg-warning-bg px-3 py-2.5 text-[12px] leading-snug text-warning">
              <p>{t("DashboardIssuance.overview.authoritiesIncompleteTooltip")}</p>
              <button
                type="button"
                onClick={onViewPermissions}
                className="mt-1.5 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:decoration-2"
              >
                {t("DashboardIssuance.overview.authoritiesIncompleteLink")}
                <ArrowUpRight className="h-3 w-3" />
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
    <div className="flex flex-1 items-center gap-3 p-4">
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
