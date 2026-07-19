import { SkeletonBlock } from "@/components/ui/skeleton-block";

const skeletonSectionClassName =
  "min-w-0 rounded-lg border border-border-default bg-surface-raised p-4";
const ACTIVITY_SKELETON_ROW_IDS = ["one", "two", "three", "four", "five"];

export function PaymentsBalanceSkeleton() {
  return (
    <section
      className={skeletonSectionClassName}
      aria-busy="true"
      data-payments-overview-skeleton="balance"
    >
      <SkeletonBlock className="h-5 w-36" />
      <SkeletonBlock className="mt-3 h-9 w-40" />
      <SkeletonBlock className="mt-2 h-4 w-28" />
      <div className="mt-4 space-y-1 border-t border-border-default pt-1">
        <SkeletonBlock className="h-9 w-full" />
        <SkeletonBlock className="h-9 w-full" />
        <SkeletonBlock className="h-9 w-full" />
      </div>
    </section>
  );
}

export function PaymentsActivitySkeleton() {
  return (
    <section
      className={skeletonSectionClassName}
      aria-busy="true"
      data-payments-overview-skeleton="activity"
    >
      <SkeletonBlock className="h-5 w-24" />
      <div className="mt-3 flex gap-5 border-b border-border-default pb-2">
        <SkeletonBlock className="h-4 w-16" />
        <SkeletonBlock className="h-4 w-14" />
      </div>
      <div className="mt-2 space-y-1 rounded-md border border-border-default p-1">
        {ACTIVITY_SKELETON_ROW_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-11 w-full rounded-sm" />
        ))}
      </div>
      <SkeletonBlock className="mt-3 h-4 w-28" />
    </section>
  );
}

export function PaymentsUpcomingSkeleton() {
  return (
    <section
      className={skeletonSectionClassName}
      aria-busy="true"
      data-payments-overview-skeleton="upcoming"
    >
      <SkeletonBlock className="h-5 w-36" />
      <SkeletonBlock className="mt-4 h-12 w-full" />
      <SkeletonBlock className="mt-1 h-12 w-full" />
    </section>
  );
}

export function PaymentsNetworkSkeleton() {
  return (
    <section
      className={`${skeletonSectionClassName} pb-0`}
      aria-busy="true"
      data-payments-overview-skeleton="network"
    >
      <SkeletonBlock className="h-5 w-36" />
      <div className="mt-4 grid grid-cols-2 gap-4">
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
      </div>
      <SkeletonBlock className="-mx-4 mt-4 h-11 w-[calc(100%+2rem)] rounded-none" />
    </section>
  );
}
