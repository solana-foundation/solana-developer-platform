import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_ROW_IDS = ["overview-balance-1", "overview-balance-2", "overview-balance-3"];
const TILE_IDS = ["overview-tile-1", "overview-tile-2", "overview-tile-3", "overview-tile-4"];
const CHART_IDS = ["overview-chart-1", "overview-chart-2", "overview-chart-3", "overview-chart-4"];

/**
 * Mirrors the Overview's settled layout: the balance column beside the action tiles, then the
 * network header over its four charts. The quick start and the approvals list stay out; they
 * appear only when there is something in them, and a placeholder would promise both.
 */
export default function DashboardLoading() {
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-16"
      data-loading-layout="home"
      aria-busy="true"
    >
      <div className="grid min-w-0 gap-10 lg:grid-cols-2 lg:gap-12" data-loading-home-hero>
        <div className="min-w-0">
          <SkeletonBlock className="h-5 w-24 rounded-[4px]" />
          <SkeletonBlock className="mt-1 h-11 w-56 max-w-full rounded-[6px]" />
          <div className="mt-8 space-y-2">
            {BALANCE_ROW_IDS.map((id) => (
              <div key={id} className="flex h-11 items-center gap-4">
                <SkeletonBlock className="size-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <SkeletonBlock className="h-4 w-16 rounded-[4px]" />
                  <SkeletonBlock className="h-3.5 w-20 rounded-[4px]" />
                </div>
                <SkeletonBlock className="h-4 w-20 rounded-[4px]" />
              </div>
            ))}
          </div>
          <div className="mt-9 border-t border-border-default pt-6">
            <SkeletonBlock className="h-6 w-72 max-w-full rounded-[4px]" />
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 content-start gap-2">
          {TILE_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-[120px] rounded-control" />
          ))}
        </div>
      </div>
      <div className="min-w-0" data-loading-home-network>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SkeletonBlock className="h-6 w-44 rounded-[4px]" />
          <SkeletonBlock className="h-control-sm w-80 max-w-full rounded-control" />
        </div>
        <div className="mt-5 grid min-w-0 gap-x-12 gap-y-10 md:grid-cols-2">
          {CHART_IDS.map((id) => (
            <div key={id} className="min-w-0">
              <SkeletonBlock className="h-5 w-36 rounded-[4px]" />
              <SkeletonBlock className="mt-1 h-[30px] w-32 rounded-[4px]" />
              <SkeletonBlock className="mt-5 h-[182px] w-full rounded-control" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
