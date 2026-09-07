"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { formatDateTime } from "../../token-management-workspace.utils";
import { fetchAssetAuditHistory } from "../asset-audit.data";
import { auditActionLabel, auditStatusBadgeClass } from "../asset-audit-presentation";
import type { TokenOperations } from "../use-token-operations";

export function OverviewTab({
  token,
  draft,
  ops,
  onViewActivity,
  onViewPermissions,
  onViewOperations,
}: {
  token: Token;
  assetProfile: AssetProfile;
  draft: DraftState;
  ops: TokenOperations;
  onViewActivity: () => void;
  onViewPermissions: () => void;
  onViewOperations: () => void;
}) {
  const t = useTranslations();
  const deployed = Boolean(token.mintAddress);
  const controls = deployed
    ? [
        token.extensions?.pausable && t("DashboardIssuance.simplified.pause"),
        token.isFreezable && t("DashboardIssuance.simplified.freeze"),
        token.extensions?.permanentDelegate && t("DashboardIssuance.compliance.forceTransfer"),
      ].filter(Boolean)
    : Object.keys(draft.advancedSettings)
        .filter((key) => ["pauseTransfers", "freezeAccounts", "permanentDelegate"].includes(key))
        .map(
          (key) =>
            ({
              pauseTransfers: t("DashboardIssuance.simplified.pause"),
              freezeAccounts: t("DashboardIssuance.simplified.freeze"),
              permanentDelegate: t("DashboardIssuance.compliance.forceTransfer"),
            })[key]
        );
  const accessLabel = t(
    ops.accessControlMode === "allowlist"
      ? "DashboardIssuance.simplified.approvedRecipients"
      : ops.accessControlMode === "blocklist"
        ? "DashboardIssuance.simplified.blockedRecipients"
        : "DashboardIssuance.simplified.anyRecipient"
  );

  return (
    <div className="space-y-5 sm:space-y-8">
      {token.description || draft.website ? (
        <div className="hidden max-w-3xl space-y-3 sm:block">
          {token.description ? (
            <p className="text-sm leading-relaxed text-secondary">{token.description}</p>
          ) : null}
          {/^https?:\/\//i.test(draft.website) ? (
            <a
              href={draft.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 break-all text-sm text-secondary hover:underline"
            >
              {draft.website}
              <ArrowUpRight className="size-3.5 shrink-0" />
            </a>
          ) : null}
        </div>
      ) : null}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardIssuance.simplified.controls")}
          </h3>
          <Button variant="ghost" size="sm" onClick={onViewOperations} iconRight={<ArrowRight />}>
            {t("DashboardIssuance.simplified.manage")}
          </Button>
        </div>
        <dl className="divide-y divide-border-subtle text-sm">
          <SummaryRow label={t("DashboardIssuance.summary.accessControl")}>
            {accessLabel}
            {deployed && ops.showControlList ? (
              <span className="ml-2 text-tertiary">
                <CountValue
                  error={ops.allowlistError}
                  loading={ops.allowlistTotal === null}
                  count={ops.allowlistTotal ?? 0}
                />
              </span>
            ) : null}
          </SummaryRow>
          {controls.length ? (
            <SummaryRow label={t("DashboardIssuance.simplified.controls")}>
              {controls.join(" · ")}
            </SummaryRow>
          ) : null}
          {deployed && token.isFreezable ? (
            <SummaryRow label={t("DashboardIssuance.simplified.frozenBalances")}>
              <CountValue
                error={ops.frozenAccountsError}
                loading={ops.supportingDataLoading}
                count={ops.frozenAccountsTotal ?? ops.frozenAccounts.length}
              />
            </SummaryRow>
          ) : null}
        </dl>
        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={onViewPermissions}
          iconRight={<ArrowRight />}
        >
          {t("DashboardIssuance.simplified.permissionsLink")}
        </Button>
      </section>
      <div className="hidden sm:block">
        <RecentActivity tokenId={token.id} onViewAll={onViewActivity} />
      </div>
    </div>
  );
}

function CountValue({
  error,
  loading,
  count,
}: {
  error: string | null;
  loading: boolean;
  count: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (error) return <span title={error}>{t("DashboardIssuance.simplified.countUnavailable")}</span>;
  if (loading) return <SkeletonBlock className="inline-block h-4 w-12" />;
  return count.toLocaleString(locale);
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <dt className="text-tertiary">{label}</dt>
      <dd className="min-w-0 text-secondary">{children}</dd>
    </div>
  );
}

function RecentActivity({ tokenId, onViewAll }: { tokenId: string; onViewAll: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const { data, error, isLoading, mutate } = usePersistedDashboardSWR(
    ["asset-audit-recent", tokenId] as const,
    ([, id]) => fetchAssetAuditHistory(id, { pageSize: 3 }),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${tokenId}.audit.recent`, ttlMs: 30_000 }
  );
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardIssuance.activity.recentTitle")}
        </h3>
        <Button variant="ghost" size="sm" onClick={onViewAll} iconRight={<ArrowRight />}>
          {t("DashboardIssuance.activity.viewAll")}
        </Button>
      </div>
      {isLoading && !data ? (
        <div aria-busy="true" className="divide-y divide-border-subtle">
          {["a", "b", "c"].map((id) => (
            <div key={id} className="flex justify-between gap-6 py-5">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : error ? (
        <button
          type="button"
          onClick={() => void mutate()}
          className="py-4 text-sm text-error underline"
        >
          {t("DashboardIssuance.errors.tokenListRetry")}
        </button>
      ) : !data?.events.length ? (
        <p className="py-5 text-sm text-tertiary">{t("DashboardIssuance.activity.empty")}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {data.events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4 text-sm text-secondary"
            >
              <span className="min-w-0 flex-1 basis-40">{auditActionLabel(event.action)}</span>
              <span className="text-tertiary">{event.actorLabel}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${auditStatusBadgeClass(event.status)}`}
              >
                {t(
                  event.status === "failure"
                    ? "DashboardIssuance.activity.statusFailure"
                    : "DashboardIssuance.activity.statusSuccess"
                )}
              </span>
              <span className="text-tertiary tabular-nums">
                {formatDateTime(event.createdAt, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
