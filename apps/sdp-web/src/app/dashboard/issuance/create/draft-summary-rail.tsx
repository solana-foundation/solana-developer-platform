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
import { cn } from "@/lib/utils";
import { accessControlLabel, getPegSummary } from "./asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "./asset-taxonomy";
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

function formatUpdatedAt(updatedAt: string | null): string | null {
  if (!updatedAt) {
    return null;
  }
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DraftSummaryRail({ draft, updatedAt, review }: DraftSummaryRailProps) {
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;
  const website = draft.website.trim();
  const pegSummary = getPegSummary(draft);

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-border-default bg-white p-5">
        <p className="text-base font-medium text-primary">Summary</p>

        <div className="mt-3">
          <SummaryRow icon={Layers} label="Asset category" value={categoryLabel} />
          <SummaryRow icon={Tag} label="Asset type" value={typeLabel} />
          <SummaryRow icon={FileText} label="Name" value={draft.name} />
          <SummaryRow icon={DollarSign} label="Symbol" value={draft.symbol} />
          <SummaryRow icon={Hash} label="Decimals" value={draft.decimals} />
          {pegSummary ? <SummaryRow icon={Anchor} label="Pegged to" value={pegSummary} /> : null}
          <SummaryRow
            icon={ShieldCheck}
            label="Access control"
            value={accessControlLabel(draft.accessControl)}
          />
          <SummaryRow
            icon={ArrowLeftRight}
            label="Transfer restrictions"
            value={transferRestrictionsEnabled ? "Enabled" : null}
          />
          <SummaryRow
            icon={ClipboardList}
            label="Investor reporting"
            value={draft.capacities.investorReporting ? "Enabled" : null}
          />
          <SummaryRow
            icon={Globe}
            label="Website"
            value={website || null}
            href={safeLinkHref(website) ?? null}
          />
          <SummaryRow icon={Clock} label="Last updated" value={formatUpdatedAt(updatedAt)} />
        </div>

        {review ? (
          <div className="mt-4">
            {review.blockers.length > 0 ? (
              <div className="rounded-xl border border-destructive-border bg-destructive-bg p-3">
                <div className="flex items-center gap-2 text-destructive-strongest">
                  <CircleAlert className="h-4 w-4 shrink-0" />
                  <p className="text-sm font-semibold">Resolve before creating</p>
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
                    You&apos;re ready to create a draft
                  </p>
                  <p className="mt-0.5 text-xs text-success">
                    You can review, edit, and publish when you&apos;re ready.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-fill-subtle p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-tertiary" />
            <div>
              <p className="text-xs font-semibold text-primary">Private by default</p>
              <p className="mt-0.5 text-xs text-tertiary">
                Details you provide are private and only used to configure your asset.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
