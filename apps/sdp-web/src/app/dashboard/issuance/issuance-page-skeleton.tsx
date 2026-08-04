"use client";

import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useIssuanceTokenView } from "@/contexts/dashboard-workspace-context";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";
import type { TokenView } from "./issuance-token-view";

const ISSUANCE_SKELETON_IDS = [
  "issuance-skeleton-1",
  "issuance-skeleton-2",
  "issuance-skeleton-3",
  "issuance-skeleton-4",
  "issuance-skeleton-5",
  "issuance-skeleton-6",
];

const ISSUANCE_DETAIL_ROW_IDS = [
  "issuance-detail-row-1",
  "issuance-detail-row-2",
  "issuance-detail-row-3",
  "issuance-detail-row-4",
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
  "issuance-detail-tab-6",
  "issuance-detail-tab-7",
];

const ISSUANCE_HERO_TILE_IDS = [
  "issuance-hero-tile-1",
  "issuance-hero-tile-2",
  "issuance-hero-tile-3",
  "issuance-hero-tile-4",
  "issuance-hero-tile-5",
  "issuance-hero-tile-6",
];

const ISSUANCE_WIZARD_CARD_IDS = [
  "issuance-wizard-card-1",
  "issuance-wizard-card-2",
  "issuance-wizard-card-3",
  "issuance-wizard-card-4",
  "issuance-wizard-card-5",
  "issuance-wizard-card-6",
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
  assetProfilesEnabled = false,
  view,
}: {
  assetProfilesEnabled?: boolean;
  /** Overrides the stored preference; for tests and Storybook-style callers. */
  view?: TokenView;
}) {
  // Grid and list are different enough that one skeleton can only be right for
  // half the users — hence two, picked by the same preference the workspace
  // itself reads. It comes from a cookie, so this is correct on the server too.
  const storedView = useIssuanceTokenView();
  const resolvedView = view ?? storedView;

  // Legacy list skeleton when the Asset Profiles UI flag is off, so the loading
  // state matches the old grid instead of flashing the new one. The view toggle
  // is part of the new overview only, so this branch is always a grid.
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
    <DashboardWorkspaceOverviewPanel
      data-loading-layout="issuance-overview"
      data-loading-view={resolvedView}
      aria-busy="true"
    >
      {/* Mirrors IssuanceWorkspace's pinned header — toolbar, then the asset-count
          row — down to its spacing (`space-y-4` inside, `pb-3` below, matching the
          header's fade band), so the content underneath starts on the same
          baseline it will settle at. */}
      <div className="space-y-4 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3 sm:flex-1">
            <SkeletonBlock className="h-10 flex-1 rounded-[10px]" />
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-[10px]" />
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-[10px]" />
          </div>
          <SkeletonBlock className="h-10 w-full rounded-[10px] sm:w-32" />
        </div>

        {/* Asset count (same width the workspace's own count placeholder takes),
            and — list view only, as in the workspace — the expand/collapse-all
            control opposite it. */}
        <div className="flex h-6 items-center justify-between px-1">
          <SkeletonBlock className="h-3 w-28" />
          {resolvedView === "list" ? <SkeletonBlock className="h-3 w-20" /> : null}
        </div>
      </div>

      {/* The rows/tiles themselves live in issuance-list-skeleton.tsx, shared with
          the workspace's in-place reload state so the two can't drift. */}
      <IssuanceListSkeleton view={resolvedView} count={ISSUANCE_SKELETON_IDS.length} />
    </DashboardWorkspaceOverviewPanel>
  );
}

function WizardStepIndicatorSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <SkeletonBlock className="h-1.5 w-4 rounded-full" />
        <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
        <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
      </div>
      <SkeletonBlock className="h-3 w-20" />
    </div>
  );
}

function WizardActionBarSkeleton() {
  return (
    <div
      className="shrink-0 border-t border-border-default bg-surface-raised px-4 py-4 md:px-6"
      data-loading-action-bar
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
        <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
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
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <WizardStepIndicatorSkeleton />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto grid w-full max-w-6xl gap-8 pb-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0 space-y-6">
            <div>
              <SkeletonBlock className="h-6 w-56" />
              <SkeletonBlock className="mt-2 h-4 w-full max-w-md" />
            </div>
            <div className="max-w-md space-y-2">
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-10 w-full rounded-lg" />
              <SkeletonBlock className="h-4 w-3/4" />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {ISSUANCE_WIZARD_CARD_IDS.map((id) => (
                  <div
                    key={id}
                    className="min-h-32 rounded-xl border border-border-default bg-surface-raised p-4"
                  >
                    <SkeletonBlock className="size-9 rounded-lg" />
                    <SkeletonBlock className="mt-4 h-4 w-24" />
                    <SkeletonBlock className="mt-2 h-3 w-full" />
                    <SkeletonBlock className="mt-2 h-3 w-4/5" />
                  </div>
                ))}
              </div>
            </div>
          </main>

          <aside className="lg:sticky lg:top-4" data-loading-summary-rail>
            <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
              <SkeletonBlock className="h-5 w-48" />
              <div className="mt-4 space-y-4">
                {ISSUANCE_DETAIL_ROW_IDS.map((id) => (
                  <div key={id} className="flex items-center gap-3">
                    <SkeletonBlock className="size-9 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <SkeletonBlock className="h-4 w-2/3" />
                      <SkeletonBlock className="h-3 w-full" />
                    </div>
                  </div>
                ))}
              </div>
              <SkeletonBlock className="mt-5 h-16 w-full rounded-xl" />
            </div>
          </aside>
        </div>
      </div>

      <WizardActionBarSkeleton />
    </div>
  );
}

function HeroIdentityFieldSkeleton({ valueWidth }: { valueWidth: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <SkeletonBlock className="size-3 shrink-0 rounded-[3px]" />
        <SkeletonBlock className="h-3 w-20" />
      </div>
      <SkeletonBlock className={`mt-1 h-4 ${valueWidth}`} />
    </div>
  );
}

function HeroStatTileSkeleton() {
  return (
    <div className="flex h-full flex-col py-2.5 md:px-3">
      <div className="flex items-center gap-1.5">
        <SkeletonBlock className="size-3 shrink-0 rounded-[3px]" />
        <SkeletonBlock className="h-3 w-16" />
      </div>
      <div className="mt-auto pt-0.5">
        <SkeletonBlock className="h-4 w-20" />
      </div>
    </div>
  );
}

function ClassificationCellSkeleton() {
  return (
    <div className="flex flex-1 items-center gap-3 p-4">
      <SkeletonBlock className="size-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="mt-1.5 h-3 w-full max-w-64" />
      </div>
    </div>
  );
}

export function IssuanceDetailSkeleton() {
  return (
    <div className="space-y-4 pb-8" data-loading-layout="issuance-detail" aria-busy="true">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <SkeletonBlock className="size-16 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <SkeletonBlock className="h-8 w-56 max-w-full" />
              <SkeletonBlock className="h-6 w-16 rounded-full" />
              <SkeletonBlock className="h-6 w-20 rounded-full" />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <SkeletonBlock className="h-7 w-28 rounded-full" />
              <SkeletonBlock className="h-7 w-32 rounded-full" />
            </div>
            <div
              className="mt-2.5 flex min-h-14 flex-col gap-1 sm:min-h-6 sm:flex-row sm:items-start sm:gap-4"
              data-loading-identity-rows="issuance-detail"
            >
              <div className="shrink-0" data-loading-address-row>
                <SkeletonBlock className="h-6 w-28" />
              </div>
              <div className="flex min-w-0 flex-1 items-start gap-1">
                <div className="min-w-0 flex-1 space-y-1" data-loading-token-id-lines="2">
                  <SkeletonBlock className="h-3 w-full max-w-72" />
                  <div className="sm:hidden" data-loading-token-id-continuation>
                    <SkeletonBlock className="h-3 w-28" />
                  </div>
                </div>
                <SkeletonBlock className="size-6 shrink-0 rounded-md" />
              </div>
            </div>
          </div>
        </div>
        {/* API Playground + Explorer */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-28 rounded-[10px]" />
        </div>
      </header>

      <div
        className="flex gap-8 overflow-x-auto border-b border-border-default pt-3 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-loading-tab-list="issuance-detail"
      >
        {ISSUANCE_DETAIL_TAB_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-4 w-20 shrink-0" />
        ))}
      </div>

      <div className="space-y-4 pt-1">
        <section className="rounded-2xl border border-border-default bg-surface-raised p-5">
          <div className="grid gap-4 md:grid-cols-2 md:gap-5">
            <div className="flex min-w-0 flex-col">
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="mt-2 h-4 w-4/5" />
              <div className="mt-6 flex flex-col gap-3 md:mt-auto md:pt-6">
                <HeroIdentityFieldSkeleton valueWidth="w-40" />
                <HeroIdentityFieldSkeleton valueWidth="w-full max-w-72" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 md:gap-0 md:border-l md:border-border-subtle md:pl-5">
              {ISSUANCE_HERO_TILE_IDS.map((id) => (
                <HeroStatTileSkeleton key={id} />
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <section className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
            <ClassificationCellSkeleton />
            <ClassificationCellSkeleton />
          </section>
          <section className="flex h-full flex-col rounded-2xl border border-border-default bg-surface-raised px-4 pt-4">
            <div className="flex items-center justify-between gap-2">
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-3.5 w-16" />
            </div>
            <ul className="mt-3 flex min-h-0 flex-1 flex-col">
              {RECENT_ACTIVITY_ROW_IDS.map((id) => (
                <li
                  key={id}
                  className="flex flex-1 items-center justify-between gap-3 border-t border-border-subtle py-3 first:border-t-0"
                >
                  <SkeletonBlock className="h-6 w-28 shrink-0 rounded-md" />
                  <SkeletonBlock className="h-3.5 w-32" />
                  <SkeletonBlock className="h-4 w-16 shrink-0 rounded-full" />
                  <SkeletonBlock className="h-3.5 w-24 shrink-0" />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
