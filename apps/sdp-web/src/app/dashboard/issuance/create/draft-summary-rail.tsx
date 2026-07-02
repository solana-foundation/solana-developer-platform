"use client";

import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { accessControlLabel } from "./asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "./asset-taxonomy";
import type { DraftState } from "./issuance-draft-wizard.types";

interface DraftSummaryRailProps {
  draft: DraftState;
  updatedAt: string | null;
}

interface SummaryRowProps {
  label: string;
  value: string | null;
}

function SummaryRow({ label, value }: SummaryRowProps) {
  const hasValue = value !== null && value.trim().length > 0;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[rgba(28,28,29,0.06)] py-2.5 last:border-b-0">
      <span className="text-sm text-[rgba(28,28,29,0.58)]">{label}</span>
      <span className="min-w-0 text-right">
        <span
          className={cn(
            "block truncate text-sm font-medium",
            hasValue ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.4)]"
          )}
        >
          {hasValue ? value : "—"}
        </span>
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
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function DraftSummaryRail({ draft, updatedAt }: DraftSummaryRailProps) {
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <p className="text-base font-medium text-[#1c1c1d]">Summary</p>

        <div className="mt-3">
          <SummaryRow label="Asset category" value={categoryLabel} />
          <SummaryRow label="Asset type" value={typeLabel} />
          <SummaryRow label="Name" value={draft.name} />
          <SummaryRow label="Symbol" value={draft.symbol} />
          <SummaryRow label="Decimals" value={draft.decimals} />
          <SummaryRow label="Access control" value={accessControlLabel(draft.accessControl)} />
          <SummaryRow
            label="Transfer restrictions"
            value={transferRestrictionsEnabled ? "Enabled" : null}
          />
          <SummaryRow
            label="Investor reporting"
            value={draft.capacities.investorReporting ? "Enabled" : null}
          />
          <SummaryRow label="Website" value={draft.website} />
          <SummaryRow label="Last updated" value={formatUpdatedAt(updatedAt)} />
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-xl bg-[rgba(28,28,29,0.03)] p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
          <div>
            <p className="text-xs font-semibold text-[#1c1c1d]">Private by default</p>
            <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.58)]">
              Details you provide are private and only used to configure your asset.
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
