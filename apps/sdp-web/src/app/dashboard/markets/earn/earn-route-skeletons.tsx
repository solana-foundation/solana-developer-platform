import { SkeletonBlock } from "@/components/ui/skeleton-block";

const SKELETON_ITEM_IDS = ["one", "two", "three", "four"];

export function EarnOverviewSkeleton() {
  return (
    <div className="grid content-start gap-4" aria-busy="true">
      <SkeletonBlock className="h-4 w-96 max-w-full" />
      <section className="rounded-lg border border-border-default bg-surface-raised p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-5 w-40" />
            <SkeletonBlock className="mt-2 h-4 w-80 max-w-full" />
          </div>
          <SkeletonBlock className="h-9 w-28 rounded-md" />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {SKELETON_ITEM_IDS.slice(0, 3).map((id) => (
            <SkeletonBlock key={id} className="h-[4.5rem] w-full rounded-md" />
          ))}
        </div>
        <div className="mt-3 grid gap-3">
          {SKELETON_ITEM_IDS.slice(0, 2).map((id) => (
            <SkeletonBlock key={id} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-border-default bg-surface-raised p-4">
        <SkeletonBlock className="h-5 w-36" />
        <SkeletonBlock className="mt-2 h-4 w-[34rem] max-w-full" />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {SKELETON_ITEM_IDS.slice(0, 3).map((id) => (
            <SkeletonBlock key={id} className="h-96 w-full rounded-xl" />
          ))}
        </div>
      </section>
    </div>
  );
}

export function EarnDepositSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" aria-busy="true">
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-4xl">
          <SkeletonBlock className="h-2 w-32 rounded-full" />
        </div>
      </div>
      <div className="min-h-0 flex-1 px-4 md:px-6">
        <div className="mx-auto w-full max-w-4xl pb-8">
          <SkeletonBlock className="h-7 w-64" />
          <SkeletonBlock className="mt-2 h-4 w-96 max-w-full" />
          {/* Mirrors the flow's first step: a framed note above a stacked list
              of selectable funding-wallet rows. */}
          <SkeletonBlock className="mt-6 h-20 w-full rounded-2xl" />
          <div className="mt-5 grid gap-3">
            {SKELETON_ITEM_IDS.map((id) => (
              <SkeletonBlock key={id} className="h-28 w-full rounded-2xl" />
            ))}
          </div>
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
          {SKELETON_ITEM_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-16 w-full rounded-md" />
          ))}
        </div>
        <SkeletonBlock className="mt-4 h-48 w-full rounded-md" />
      </section>
    </div>
  );
}
