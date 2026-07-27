"use client";

import type { AssetProfile, Token } from "@sdp/types";
import {
  Activity,
  ArrowUpRight,
  Clock,
  Coins,
  Hash,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Signature,
} from "lucide-react";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  AssetOverviewHero,
  AuthoritiesGlyph,
  StatTile,
  WalletIdentityBadge,
} from "../../../asset-overview-hero";
import { getCategoryPresentation, getSubTypePresentation } from "../../../create/asset-taxonomy";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import {
  buildAuthorityGlyphRows,
  buildWalletIdentityForSigner,
  formatSmartSupply,
  resolveAccessMode,
} from "../../../issuance-token-fields";
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
  const category = getCategoryPresentation(assetProfile.assetCategory);
  const subType = getSubTypePresentation(assetProfile.assetCategory, assetProfile.assetType);

  const statusLabels: Record<Token["status"], string> = {
    pending: t("DashboardIssuance.status.draft"),
    active: t("DashboardIssuance.status.active"),
    paused: t("DashboardIssuance.status.paused"),
    revoked: t("DashboardIssuance.status.revoked"),
  };

  // Smart supply / date + authority glyph, composed identically to the issuance
  // list's expanded card (see buildOverviewHeroData) so the two surfaces match.
  const supply = formatSmartSupply(token.totalSupply, token.maxSupply, locale);
  const deployed = Boolean(token.deployedAt);
  const date = deployed
    ? {
        label: t("DashboardIssuance.overview.deployed"),
        value: formatDate(token.deployedAt, locale),
        tooltip: t("DashboardIssuance.overview.deployedTooltip"),
      }
    : {
        label: t("DashboardIssuance.list.created"),
        value: formatDate(token.createdAt, locale),
        tooltip: t("DashboardIssuance.overview.createdTooltip"),
      };
  const authorityRows = buildAuthorityGlyphRows(
    token,
    ops.authorityWallets,
    ops.authoritySummary.known,
    t
  );
  const signerWallet = buildWalletIdentityForSigner(token.signingWalletId, ops.authorityWallets, t);

  return (
    <div className="space-y-4">
      {/* Identity hero — shared, presentational; also used by the issuance list's
          expanded card so both surfaces stay identical. Tiles: Status · Smart supply
          · Decimals · Smart date · Authorities glyph · Signer wallet. */}
      <AssetOverviewHero
        description={token.description}
        website={draft.website}
        mintAddress={token.mintAddress}
        onCopyMintAddress={(value) => void ops.handleCopy(value)}
        tiles={
          <>
            <StatTile
              icon={Activity}
              label={t("DashboardIssuance.transactions.status")}
              value={statusLabels[token.status]}
            />
            <StatTile
              icon={Coins}
              label={t("DashboardIssuance.overview.totalSupply")}
              value={supply}
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
              label={date.label}
              value={<span title={date.tooltip}>{date.value}</span>}
            />
            <StatTile
              icon={ShieldCheck}
              label={t("DashboardIssuance.overview.authorities")}
              value={
                <AuthoritiesGlyph
                  rows={authorityRows}
                  accessMode={resolveAccessMode(token, draft)}
                  onCopy={(value) => void ops.handleCopy(value)}
                  onViewPermissions={onViewPermissions}
                />
              }
            />
            <StatTile
              icon={Signature}
              label={t("DashboardIssuance.overview.signerWallet")}
              value={
                signerWallet ? (
                  <WalletIdentityBadge
                    identity={signerWallet}
                    onCopy={(value) => void ops.handleCopy(value)}
                  />
                ) : null
              }
            />
          </>
        }
      />

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
          // Mirror the loaded layout so the skeleton reflows identically: two
          // stacked rows on the narrow card, one subgrid row at @xl (desktop).
          <ul
            className="grid min-h-0 flex-1 auto-rows-fr @xl:grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] @xl:gap-x-3"
            aria-busy="true"
          >
            {["a", "b", "c"].map((skeletonRow) => (
              <li
                key={skeletonRow}
                className="flex flex-col justify-center gap-2 border-t border-border-subtle py-3 first:border-t-0 @xl:col-span-full @xl:grid @xl:grid-cols-subgrid @xl:items-center @xl:justify-normal @xl:gap-x-3"
              >
                <div className="flex items-center justify-between gap-2 @xl:contents">
                  <SkeletonBlock className="h-6 w-28 rounded-md @xl:col-start-1 @xl:row-start-1 @xl:justify-self-start" />
                  <SkeletonBlock className="h-3.5 w-24 @xl:col-start-4 @xl:row-start-1 @xl:justify-self-end" />
                </div>
                <div className="flex items-center justify-between gap-2 @xl:contents">
                  <SkeletonBlock className="h-3.5 w-32 @xl:col-start-2 @xl:row-start-1" />
                  <SkeletonBlock className="h-4 w-16 rounded-full @xl:col-start-3 @xl:row-start-1 @xl:justify-self-end" />
                </div>
              </li>
            ))}
          </ul>
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
