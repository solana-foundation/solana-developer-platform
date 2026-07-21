import { SkeletonBlock } from "@/components/ui/skeleton-block";

const STRATEGY_ROW_IDS = ["one", "two", "three", "four"];

export function EarnOverviewSkeleton() {
  return (
    <div className="grid content-start gap-4" aria-busy="true">
      <section className="rounded-lg border border-border-default bg-surface-raised p-4">
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="mt-2 h-4 w-72" />
        <div className="mt-4 grid gap-2">
          {STRATEGY_ROW_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-10 w-full rounded-md" />
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-border-default bg-surface-raised p-4">
        <SkeletonBlock className="h-5 w-24" />
        <SkeletonBlock className="mt-4 h-4 w-64" />
      </section>
    </div>
  );
}

export function EarnDepositSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" aria-busy="true">
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6">
        <SkeletonBlock className="h-3 w-40" />
      </div>
      <div className="min-h-0 flex-1 px-4 md:px-6">
        <div className="mx-auto grid w-full max-w-4xl gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div>
            <SkeletonBlock className="h-7 w-56" />
            <SkeletonBlock className="mt-2 h-4 w-80" />
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {STRATEGY_ROW_IDS.slice(0, 3).map((id) => (
                <SkeletonBlock key={id} className="h-32 w-full rounded-2xl" />
              ))}
            </div>
          </div>
          <SkeletonBlock className="hidden h-40 w-full rounded-lg lg:block" />
        </div>
      </div>
      <div className="shrink-0 border-t border-border-default px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between">
          <SkeletonBlock className="h-9 w-24 rounded-md" />
          <SkeletonBlock className="h-9 w-28 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export function EarnStrategyDetailSkeleton() {
  return (
    <div className="grid content-start gap-4" aria-busy="true">
      <section className="rounded-lg border border-border-default bg-surface-raised p-4">
        <SkeletonBlock className="h-5 w-56" />
        <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
          {STRATEGY_ROW_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-16 w-full rounded-md" />
          ))}
        </div>
        <SkeletonBlock className="mt-4 h-48 w-full rounded-md" />
      </section>
    </div>
  );
}
