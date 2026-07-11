"use client";

import {
  Anchor,
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Layers,
  type LucideIcon,
  ShieldCheck,
  Tag,
} from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { accessControlLabel, getPegSummary } from "./asset-details-config";
import { getAssetTypeLabel, getCategoryLabelKey } from "./asset-taxonomy";
import { safeLinkHref } from "./draft-mapping";
import type { DraftState } from "./issuance-draft-wizard.types";

export interface RailReviewProps {
  blockers: string[];
}

interface DraftSummaryRailProps {
  draft: DraftState;
  updatedAt: string | null;
  review?: RailReviewProps;
}

interface SummaryRowProps {
  icon: LucideIcon;
  label: string;
  value: string | null;
  href?: string | null;
}

function SummaryRow({ icon: Icon, label, value, href }: SummaryRowProps) {
  const hasValue = value !== null && value.trim().length > 0;
  return (
    <div className="flex items-start gap-2.5 border-b border-[rgba(28,28,29,0.06)] py-2.5 last:border-b-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.4)]" />
      <span className="shrink-0 text-sm text-[rgba(28,28,29,0.58)]">{label}</span>
      <span className="ml-auto min-w-0 max-w-[60%] text-right">
        {hasValue && href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 break-all text-sm font-medium text-[#1c1c1d] hover:underline"
          >
            {value}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span
            className={cn(
              "block break-words text-sm font-medium",
              hasValue ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.4)]"
            )}
          >
            {hasValue ? value : "—"}
          </span>
        )}
      </span>
    </div>
  );
}

function formatUpdatedAt(updatedAt: string | null, locale: string): string | null {
  if (!updatedAt) {
    return null;
  }
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DraftSummaryRail({ draft, updatedAt, review }: DraftSummaryRailProps) {
  const t = useTranslations();
  const locale = useLocale();
  const categoryLabelKey = getCategoryLabelKey(draft.assetCategory);
  const categoryLabel = categoryLabelKey ? t(categoryLabelKey) : null;
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType, t);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;
  const website = draft.website.trim();
  const pegSummary = getPegSummary(draft);

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <p className="text-base font-medium text-[#1c1c1d]">
          {t("DashboardIssuance.summary.title")}
        </p>

        <div className="mt-3">
          <SummaryRow
            icon={Layers}
            label={t("DashboardIssuance.summary.assetCategory")}
            value={categoryLabel}
          />
          <SummaryRow
            icon={Tag}
            label={t("DashboardIssuance.summary.assetType")}
            value={typeLabel}
          />
          <SummaryRow
            icon={FileText}
            label={t("DashboardIssuance.forms.name")}
            value={draft.name}
          />
          <SummaryRow
            icon={DollarSign}
            label={t("DashboardIssuance.create.symbol")}
            value={draft.symbol}
          />
          <SummaryRow
            icon={Hash}
            label={t("DashboardIssuance.create.decimals")}
            value={draft.decimals}
          />
          {pegSummary ? (
            <SummaryRow
              icon={Anchor}
              label={t("DashboardIssuance.summary.peggedTo")}
              value={pegSummary}
            />
          ) : null}
          <SummaryRow
            icon={ShieldCheck}
            label={t("DashboardIssuance.summary.accessControl")}
            value={accessControlLabel(draft.accessControl, t)}
          />
          <SummaryRow
            icon={ArrowLeftRight}
            label={t("DashboardIssuance.summary.transferRestrictions")}
            value={transferRestrictionsEnabled ? t("DashboardIssuance.summary.enabled") : null}
          />
          <SummaryRow
            icon={ClipboardList}
            label={t("DashboardIssuance.summary.investorReporting")}
            value={
              draft.capacities.investorReporting ? t("DashboardIssuance.summary.enabled") : null
            }
          />
          <SummaryRow
            icon={Globe}
            label={t("DashboardIssuance.assetDetails.website")}
            value={website || null}
            href={safeLinkHref(website) ?? null}
          />
          <SummaryRow
            icon={Clock}
            label={t("DashboardIssuance.summary.lastUpdated")}
            value={formatUpdatedAt(updatedAt, locale)}
          />
        </div>

        {review ? (
          <div className="mt-4">
            {review.blockers.length > 0 ? (
              <div className="rounded-xl border border-[rgba(199,31,55,0.25)] bg-[rgba(199,31,55,0.06)] p-3">
                <div className="flex items-center gap-2 text-[#8a1f2a]">
                  <CircleAlert className="h-4 w-4 shrink-0" />
                  <p className="text-sm font-semibold">
                    {t("DashboardIssuance.summary.resolveBeforeCreating")}
                  </p>
                </div>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-[#8a1f2a]">
                  {review.blockers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-[rgba(12,128,76,0.2)] bg-[rgba(12,128,76,0.06)] p-3">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0c804c]" />
                <div>
                  <p className="text-sm font-semibold text-[#0c804c]">
                    {t("DashboardIssuance.summary.readyToCreate")}
                  </p>
                  <p className="mt-0.5 text-xs text-[rgba(12,128,76,0.85)]">
                    {t("DashboardIssuance.summary.readyDescription")}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-[rgba(28,28,29,0.03)] p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
            <div>
              <p className="text-xs font-semibold text-[#1c1c1d]">
                {t("DashboardIssuance.summary.privateByDefault")}
              </p>
              <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.58)]">
                {t("DashboardIssuance.summary.privateDescription")}
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
