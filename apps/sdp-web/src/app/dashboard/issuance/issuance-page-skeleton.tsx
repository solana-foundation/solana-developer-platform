"use client";

import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";

const ISSUANCE_SKELETON_IDS = [
  "issuance-skeleton-1",
  "issuance-skeleton-2",
  "issuance-skeleton-3",
  "issuance-skeleton-4",
  "issuance-skeleton-5",
  "issuance-skeleton-6",
];

const RECENT_ACTIVITY_ROW_IDS = [
  "recent-activity-row-1",
  "recent-activity-row-2",
  "recent-activity-row-3",
];

const ISSUANCE_DETAIL_TAB_IDS = [
  "issuance-detail-tab-1",
  "issuance-detail-tab-2",
  "issuance-detail-tab-3",
  "issuance-detail-tab-4",
  "issuance-detail-tab-5",
];

const ISSUANCE_CLASSIFICATION_CARD_IDS = [
  "issuance-classification-card-1",
  "issuance-classification-card-2",
];

// Loading card for the legacy list (flag off): taller card with a Type/Supply/
// Created stat box and a full-width Manage button, no chips or kebab.
function LegacyIssuanceTokenCardSkeleton() {
  return (
    <article
      className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5"
      data-loading-card="issuance-token"
    >
      <SkeletonBlock className="mb-4 h-14 w-14 rounded-full" />
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="mt-3 h-8 w-3/4" />
      <div className="mt-6 space-y-3 rounded-xl border border-border-subtle bg-fill-subtle p-3">
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-[86%]" />
        <SkeletonBlock className="h-4 w-[78%]" />
      </div>
      <div className="mt-auto pt-3">
        <SkeletonBlock className="h-11 w-full rounded-[10px]" />
      </div>
    </article>
  );
}

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
          <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
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

function WizardStepIndicatorSkeleton() {
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-1.5">
        <SkeletonBlock className="h-1.5 w-5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
      </div>
      <SkeletonBlock className="h-3 w-[68px]" />
    </div>
  );
}

function WizardActionBarSkeleton() {
  return (
    <div
      className="shrink-0 border-t border-border-default px-[22px] py-4 min-[901px]:px-10"
      data-loading-action-bar
    >
      <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
        <SkeletonBlock className="h-[38px] w-[78px] rounded-[9px]" />
        <SkeletonBlock className="h-[38px] w-[106px] rounded-[9px]" />
      </div>
    </div>
  );
}

export function IssuanceCreateSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-loading-layout="issuance-create"
      aria-busy="true"
    >
      <div className="shrink-0 px-[22px] pt-8 pb-6 min-[901px]:px-10">
        <div className="mx-auto w-full max-w-xl">
          <WizardStepIndicatorSkeleton />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] min-[901px]:px-10">
        <main className="mx-auto w-full max-w-xl space-y-[11px] pt-6 pb-10">
          {ISSUANCE_CLASSIFICATION_CARD_IDS.map((id) => (
            <div
              key={id}
              className="grid min-h-[104px] grid-cols-[42px_minmax(0,1fr)_20px] items-center gap-[15px] rounded-[14px] border border-border-default bg-surface-raised p-5"
              data-loading-card="issuance-classification"
            >
              <SkeletonBlock className="size-[42px] rounded-[11px]" />
              <div className="min-w-0">
                <SkeletonBlock className="h-5 w-48 max-w-full" />
                <SkeletonBlock className="mt-2 h-3.5 w-full max-w-[390px]" />
              </div>
              <SkeletonBlock className="size-[19px] rounded-full" />
            </div>
          ))}
        </main>
      </div>

      <WizardActionBarSkeleton />
    </div>
  );
}

export function IssuanceDetailSkeleton() {
  return (
    <div
      className="space-y-5 px-1 pb-8 sm:space-y-6 sm:px-0"
      data-loading-layout="issuance-detail"
      aria-busy="true"
    >
      {/* Mirrors the settled asset-management header (AssetProfileHeader): a 44px
          mark beside the name and ticker chip, the meta and identifier lines under
          them, and the action buttons in the top-right corner. Built from the
          header's own spacing classes rather than measured heights, so the two
          can't drift. */}
      <header className="sm:py-2">
        <div className="flex justify-between gap-3 sm:flex-col sm:gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <SkeletonBlock className="hidden size-11 shrink-0 rounded-full sm:block" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                {/* The 24px asset name with the ticker chip beside it. */}
                <SkeletonBlock className="h-7 w-40 max-w-full sm:h-8 sm:w-52" />
                <SkeletonBlock className="hidden h-5 w-16 rounded-md sm:block" />
              </div>
              {/* Classification · status · deploy date. */}
              <div className="flex items-center" data-loading-meta-line="issuance-detail">
                <SkeletonBlock className="h-5 w-28 max-w-full sm:w-72" />
              </div>
              {/* Mint and token id, each elided to one line with its own copy button. */}
              <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 sm:flex">
                <div className="flex items-center gap-1.5" data-loading-address-row>
                  <SkeletonBlock className="h-3.5 w-24" />
                  <SkeletonBlock className="size-5 shrink-0 rounded-md" />
                </div>
                <div className="flex items-center gap-1.5" data-loading-token-id-row>
                  <SkeletonBlock className="h-3.5 w-36" />
                  <SkeletonBlock className="size-5 shrink-0 rounded-md" />
                </div>
              </div>
            </div>
          </div>

          {/* API Playground + Explorer as buttons in the corner. */}
          <div className="flex shrink-0 items-center gap-2">
            <SkeletonBlock className="hidden h-8 w-32 rounded-lg sm:block" />
            <SkeletonBlock className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </header>

      <SkeletonBlock className="h-11 w-full rounded-lg sm:hidden" />
      <div
        className="hidden gap-8 overflow-x-auto border-b border-border-default pt-3 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex"
        data-loading-tab-list="issuance-detail"
      >
        {ISSUANCE_DETAIL_TAB_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-4 w-20 shrink-0" />
        ))}
      </div>

      <div className="space-y-5 pt-1 sm:space-y-8">
        <div className="grid grid-cols-2 gap-4 border-b border-border-subtle pb-5 sm:grid-cols-3 sm:gap-6 sm:pb-6">
          {["supply", "cap", "date"].map((id) => (
            <div
              key={id}
              data-loading-stat
              className={id === "date" ? "hidden sm:block" : undefined}
            >
              <SkeletonBlock className="h-5 w-24" />
              <SkeletonBlock className="mt-2 h-7 w-36" />
            </div>
          ))}
        </div>
        <div className="hidden max-w-3xl space-y-2 sm:block">
          <SkeletonBlock className="h-4 w-full" />
          <SkeletonBlock className="h-4 w-3/4" />
        </div>
        <section>
          <SkeletonBlock className="mb-3 h-5 w-32" />
          {["access", "controls", "frozen"].map((id) => (
            <div key={id} className="flex justify-between gap-4 border-b border-border-subtle py-4">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-40 max-w-[45%]" />
            </div>
          ))}
        </section>
        <section className="hidden sm:block">
          <div className="mb-2 flex justify-between">
            <SkeletonBlock className="h-5 w-32" />
            <SkeletonBlock className="h-5 w-16" />
          </div>
          {RECENT_ACTIVITY_ROW_IDS.map((id) => (
            <div
              key={id}
              className="flex flex-wrap justify-between gap-4 border-b border-border-subtle py-5"
            >
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-4 w-24" />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
