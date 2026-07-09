"use client";

import {
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
import { accessControlLabel } from "./asset-details-config";
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

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <p className="text-base font-medium text-[#1c1c1d]">Summary</p>

        <div className="mt-3">
          <SummaryRow icon={Layers} label="Asset category" value={categoryLabel} />
          <SummaryRow icon={Tag} label="Asset type" value={typeLabel} />
          <SummaryRow icon={FileText} label="Name" value={draft.name} />
          <SummaryRow icon={DollarSign} label="Symbol" value={draft.symbol} />
          <SummaryRow icon={Hash} label="Decimals" value={draft.decimals} />
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
              <div className="rounded-xl border border-[rgba(199,31,55,0.25)] bg-[rgba(199,31,55,0.06)] p-3">
                <div className="flex items-center gap-2 text-[#8a1f2a]">
                  <CircleAlert className="h-4 w-4 shrink-0" />
                  <p className="text-sm font-semibold">Resolve before creating</p>
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
                    You&apos;re ready to create a draft
                  </p>
                  <p className="mt-0.5 text-xs text-[rgba(12,128,76,0.85)]">
                    You can review, edit, and publish when you&apos;re ready.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-[rgba(28,28,29,0.03)] p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
            <div>
              <p className="text-xs font-semibold text-[#1c1c1d]">Private by default</p>
              <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.58)]">
                Details you provide are private and only used to configure your asset.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
