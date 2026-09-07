import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_SKELETON_IDS = ["one", "two", "three"];
const STRATEGY_SKELETON_IDS = ["one", "two", "three", "four", "five"];
const TREASURY_SECTION_SKELETON_IDS = ["one", "two"];
const LANDING_PATH_SKELETON_IDS = ["treasury", "program"];
const INTEGRATION_SECTION_SKELETON_IDS = ["client", "deposit", "portfolio", "withdraw"];

export function MarketsLandingSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="mt-3 h-4 w-[32rem] max-w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {LANDING_PATH_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-40 w-full rounded-2xl" key={id} />
          ))}
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function TreasurySolutionsSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" className="px-4 pt-8 pb-12 md:px-8 xl:px-9">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-16">
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[121px] rounded-xl" key={`summary-${id}`} />
          ))}
        </div>
        <section>
          <div className="flex items-center justify-between gap-4">
            <SkeletonBlock className="h-6 w-36" />
            <SkeletonBlock className="h-7 w-16 rounded-md" />
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {BALANCE_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-[175px] rounded-2xl" key={`wallet-${id}`} />
            ))}
          </div>
        </section>
        {TREASURY_SECTION_SKELETON_IDS.map((section) => (
          <section key={section}>
            <SkeletonBlock className="h-6 w-40" />
            <div className="mt-4 overflow-hidden rounded-2xl border border-border-default">
              {STRATEGY_SKELETON_IDS.slice(0, 3).map((id) => (
                <SkeletonBlock className="h-[60px] w-full rounded-none" key={`${section}-${id}`} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EmbeddedYieldPortfolioSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div
        className="mx-auto flex w-full max-w-[63rem] flex-col gap-4 pt-3"
        data-embedded-yield-loading="portfolio"
      >
        <div className="flex items-center justify-between gap-4">
          <SkeletonBlock className="h-6 w-48" />
          <SkeletonBlock className="h-6 w-20 rounded-md" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[121px] rounded-2xl" key={`portfolio-${id}`} />
          ))}
        </div>
        <SkeletonBlock className="h-[302px] w-full rounded-2xl" />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EarnIntegrationGuideSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-5xl space-y-5" data-embedded-yield-loading="integrate">
        <SkeletonBlock className="h-8 w-28 rounded-md" />
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-32" />
          <SkeletonBlock className="mt-3 h-7 w-72 max-w-full" />
          <SkeletonBlock className="mt-3 h-4 w-[38rem] max-w-full" />
        </div>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-36" />
              <SkeletonBlock className="mt-2 h-4 w-80 max-w-full" />
            </div>
            <SkeletonBlock className="h-8 w-40 rounded-md" />
          </div>
          <SkeletonBlock className="mt-6 h-12 w-full rounded-xl" />
          <SkeletonBlock className="mt-4 h-28 w-full rounded-xl" />
        </section>
        <div className="grid grid-cols-4 gap-2">
          {INTEGRATION_SECTION_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-9 w-full rounded-lg" key={id} />
          ))}
        </div>
        <section>
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="mt-2 h-4 w-[34rem] max-w-full" />
          <SkeletonBlock className="mt-6 h-56 w-full rounded-xl" />
        </section>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
