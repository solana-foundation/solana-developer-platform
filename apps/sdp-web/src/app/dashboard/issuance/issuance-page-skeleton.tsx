"use client";

import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";
import { LegacyIssuanceTokenCardSkeleton } from "./legacy-issuance-token-card-skeleton";

const ISSUANCE_SKELETON_IDS = [
  "issuance-skeleton-1",
  "issuance-skeleton-2",
  "issuance-skeleton-3",
  "issuance-skeleton-4",
  "issuance-skeleton-5",
  "issuance-skeleton-6",
];

export function IssuancePageSkeleton({
  assetProfilesEnabled = true,
}: {
  assetProfilesEnabled?: boolean;
}) {
  // Legacy list skeleton when the Asset Profiles UI flag is off, so the loading
  // state matches the old grid instead of flashing the new one.
  if (!assetProfilesEnabled) {
    return (
      <DashboardWorkspaceOverviewPanel
        className="space-y-6"
        data-loading-layout="issuance-overview"
        aria-busy="true"
      >
        <div className="flex items-center gap-3">
          <SkeletonBlock className="h-10 flex-1 rounded-[10px]" />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ISSUANCE_SKELETON_IDS.map((id) => (
            <LegacyIssuanceTokenCardSkeleton key={id} />
          ))}
        </div>
      </DashboardWorkspaceOverviewPanel>
    );
  }

  return (
    <DashboardWorkspaceOverviewPanel data-loading-layout="issuance-overview" aria-busy="true">
      {/* Mirrors IssuanceWorkspace's pinned header — the toolbar — down to its
          spacing (`space-y-4` inside, `pb-6` below), so the content underneath
          starts on the same baseline it will settle at. */}
      <div className="space-y-4 pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3 sm:flex-1">
            <SkeletonBlock className="h-10 flex-1 rounded-[10px]" />
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-[10px]" />
          </div>
          <SkeletonBlock className="h-10 w-full rounded-[10px] sm:w-32" />
        </div>
      </div>

      {/* The tiles themselves live in issuance-list-skeleton.tsx, shared with
          the workspace's in-place reload state so the two can't drift. */}
      <IssuanceListSkeleton count={ISSUANCE_SKELETON_IDS.length} />
    </DashboardWorkspaceOverviewPanel>
  );
}
