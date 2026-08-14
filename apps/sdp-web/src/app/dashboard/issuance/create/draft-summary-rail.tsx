"use client";

import {
  Anchor,
  ArrowLeftRight,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Coins,
  DollarSign,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Layers,
  type LucideIcon,
  ShieldCheck,
  Tag,
  Undo2,
  UserCheck,
} from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { accessControlLabel, getPegSummary } from "./asset-details-config";
import { getAssetTypeLabel, getCategoryLabelKey } from "./asset-taxonomy";
import { safeLinkHref } from "./draft-mapping";
import { CAPACITY_KEYS, type CapacityKey, type DraftState } from "./issuance-draft-wizard.types";

const CAPACITY_ROWS = {
  kyc: { icon: UserCheck, labelKey: "DashboardIssuance.config.kyc" },
  issueRetireControls: { icon: Coins, labelKey: "DashboardIssuance.config.issueRetireControls" },
  restrictTradingHours: {
    icon: CalendarClock,
    labelKey: "DashboardIssuance.config.restrictTradingHours",
  },
  redemptionApprovals: {
    icon: Undo2,
    labelKey: "DashboardIssuance.config.redemptionApprovals",
  },
  investorReporting: {
    icon: ClipboardList,
    labelKey: "DashboardIssuance.config.investorReporting",
  },
  transferApprovals: {
    icon: ArrowLeftRight,
    labelKey: "DashboardIssuance.config.transferApprovals",
  },
} as const satisfies Record<CapacityKey, { icon: LucideIcon; labelKey: string }>;

export interface RailReviewProps {
  blockers: string[];
}

interface DraftSummaryRailProps {
  draft: DraftState;
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
    <div className="flex items-start gap-2.5 border-b border-border-subtle py-2.5 last:border-b-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      <span className="ml-auto min-w-0 max-w-[60%] text-right">
        {hasValue && href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
          >
            {value}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span
            className={cn(
              "block break-words text-sm font-medium",
              hasValue ? "text-primary" : "text-muted"
            )}
          >
            {hasValue ? value : "—"}
          </span>
        )}
      </span>
    </div>
  );
}

export function DraftSummaryRail({ draft, review }: DraftSummaryRailProps) {
  const t = useTranslations();
  const categoryLabelKey = getCategoryLabelKey(draft.assetCategory);
  const categoryLabel = categoryLabelKey ? t(categoryLabelKey) : null;
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType, t);
  const website = draft.website.trim();
  const pegSummary = getPegSummary(draft);

  // `top-0` (not `top-4`): the rail sits at the very top of the scroll area, so
  // any positive inset would shove it below the step header even at rest. With
  // `top-0` it stays flush with the header and pins to the top on scroll.
  return (
    <aside className="lg:sticky lg:top-0">
      <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
        <p className="text-base font-medium text-primary">{t("DashboardIssuance.summary.title")}</p>

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
          {CAPACITY_KEYS.filter((key) => draft.capacities[key].enabled).map((key) => (
            <SummaryRow
              key={key}
              icon={CAPACITY_ROWS[key].icon}
              label={t(CAPACITY_ROWS[key].labelKey)}
              value={t("DashboardIssuance.summary.enabled")}
            />
          ))}
          <SummaryRow
            icon={Globe}
            label={t("DashboardIssuance.assetDetails.website")}
            value={website || null}
            href={safeLinkHref(website) ?? null}
          />
        </div>

        {review ? (
          <div className="mt-4">
            {review.blockers.length > 0 ? (
              <div className="rounded-xl border border-destructive-border bg-destructive-bg p-3">
                <div className="flex items-center gap-2 text-destructive-strongest">
                  <CircleAlert className="h-4 w-4 shrink-0" />
                  <p className="text-sm font-semibold">
                    {t("DashboardIssuance.summary.resolveBeforeCreating")}
                  </p>
                </div>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-destructive-strongest">
                  {review.blockers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-success-border bg-success-bg p-3">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <p className="text-sm font-semibold text-success">
                    {t("DashboardIssuance.summary.readyToCreate")}
                  </p>
                  <p className="mt-0.5 text-xs text-success">
                    {t("DashboardIssuance.summary.readyDescription")}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-fill-subtle p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-tertiary" />
            <div>
              <p className="text-xs font-semibold text-primary">
                {t("DashboardIssuance.summary.privateByDefault")}
              </p>
              <p className="mt-0.5 text-xs text-tertiary">
                {t("DashboardIssuance.summary.privateDescription")}
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
