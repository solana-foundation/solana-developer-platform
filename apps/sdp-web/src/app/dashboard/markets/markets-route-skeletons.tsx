import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_SKELETON_IDS = ["sol", "usdc", "usdt", "usdg"];
const STRATEGY_SKELETON_IDS = ["one", "two", "three", "four", "five"];

export function TreasurySolutionsSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-3 w-32" />
            <SkeletonBlock className="mt-3 h-4 w-[32rem] max-w-full" />
          </div>
          <SkeletonBlock className="h-6 w-20 rounded-md" />
        </div>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <SkeletonBlock className="h-5 w-44" />
          <SkeletonBlock className="mt-2 h-4 w-80 max-w-full" />
          <div className="mt-6 grid overflow-hidden rounded-xl border border-border-default sm:grid-cols-2 xl:grid-cols-4">
            {BALANCE_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-24 w-full rounded-none" key={id} />
            ))}
          </div>
        </section>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-40" />
              <SkeletonBlock className="mt-2 h-4 w-96 max-w-full" />
            </div>
            <SkeletonBlock className="h-20 w-56 rounded-xl" />
          </div>
          <div className="mt-6 overflow-hidden rounded-xl border border-border-default">
            {STRATEGY_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-20 w-full rounded-none" key={id} />
            ))}
          </div>
        </section>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EarnProgramSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <SkeletonBlock className="h-3 w-28" />
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-80 max-w-full" />
              <SkeletonBlock className="mt-3 h-4 w-[38rem] max-w-full" />
            </div>
            <SkeletonBlock className="h-6 w-24 rounded-md" />
          </div>
          <div className="mt-6 grid overflow-hidden rounded-xl border border-border-default md:grid-cols-3">
            {STRATEGY_SKELETON_IDS.slice(0, 3).map((id) => (
              <SkeletonBlock className="h-16 w-full rounded-none" key={id} />
            ))}
          </div>
        </section>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="mt-2 h-4 w-96 max-w-full" />
          <div className="mt-6 overflow-hidden rounded-xl border border-border-default">
            {STRATEGY_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-20 w-full rounded-none" key={id} />
            ))}
          </div>
        </section>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
