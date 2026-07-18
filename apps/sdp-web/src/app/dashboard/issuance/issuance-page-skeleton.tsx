import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

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

const ISSUANCE_DETAIL_TAB_IDS = [
  "issuance-detail-tab-1",
  "issuance-detail-tab-2",
  "issuance-detail-tab-3",
  "issuance-detail-tab-4",
  "issuance-detail-tab-5",
  "issuance-detail-tab-6",
];

const ISSUANCE_WIZARD_CARD_IDS = [
  "issuance-wizard-card-1",
  "issuance-wizard-card-2",
  "issuance-wizard-card-3",
  "issuance-wizard-card-4",
  "issuance-wizard-card-5",
  "issuance-wizard-card-6",
];

function IssuanceTokenCardSkeleton() {
  return (
    <article
      className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)] animate-pulse motion-reduce:animate-none"
      data-loading-card="issuance-token"
    >
      <div className="mb-4 h-14 w-14 rounded-full bg-fill" />
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

export function IssuancePageSkeleton() {
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
          <IssuanceTokenCardSkeleton key={id} />
        ))}
      </div>
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

export function IssuanceDetailSkeleton() {
  return (
    <div className="space-y-4 pb-8" data-loading-layout="issuance-detail" aria-busy="true">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <SkeletonBlock className="size-16 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <SkeletonBlock className="h-9 w-56 max-w-full" />
              <SkeletonBlock className="h-6 w-16 rounded-full" />
              <SkeletonBlock className="h-6 w-20 rounded-full" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <SkeletonBlock className="h-7 w-28 rounded-full" />
              <SkeletonBlock className="h-7 w-32 rounded-full" />
            </div>
            <SkeletonBlock className="mt-3 h-4 w-72 max-w-full" />
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
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
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex min-w-0 flex-col">
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="mt-2 h-4 w-4/5" />
              <div className="mt-8 space-y-3 md:mt-auto">
                <SkeletonBlock className="h-3 w-20" />
                <SkeletonBlock className="h-4 w-full max-w-64" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:border-l md:border-border-subtle md:pl-5">
              {ISSUANCE_WIZARD_CARD_IDS.map((id) => (
                <div key={id} className="space-y-2 py-1">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-4 w-24 max-w-full" />
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="grid overflow-hidden rounded-2xl border border-border-default bg-surface-raised sm:grid-cols-2 sm:divide-x sm:divide-border-subtle">
            <div className="flex items-start gap-3 p-4">
              <SkeletonBlock className="size-9 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-full" />
              </div>
            </div>
            <div className="flex items-start gap-3 p-4">
              <SkeletonBlock className="size-9 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-full" />
              </div>
            </div>
          </section>
          <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
            <SkeletonBlock className="h-4 w-36" />
            <SkeletonBlock className="mt-3 h-3 w-full" />
            <SkeletonBlock className="mt-2 h-3 w-4/5" />
          </section>
        </div>
      </div>
    </div>
  );
}
