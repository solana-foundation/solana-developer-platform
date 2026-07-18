import { SkeletonBlock } from "@/components/ui/skeleton-block";

const skeletonSectionClassName =
  "min-w-0 rounded-[var(--sdp-surface-radius)] border border-border-default bg-surface-raised p-5";
const ACTIVITY_SKELETON_ROW_IDS = ["one", "two", "three", "four", "five"];

export function PaymentsBalanceSkeleton() {
  return (
    <section
      className={skeletonSectionClassName}
      aria-busy="true"
      data-payments-overview-skeleton="balance"
    >
      <SkeletonBlock className="h-5 w-36" />
      <SkeletonBlock className="mt-5 h-9 w-44" />
      <div className="mt-5 space-y-2">
        <SkeletonBlock className="h-8 w-full" />
        <SkeletonBlock className="h-8 w-full" />
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
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <SkeletonBlock className="h-5 w-24" />
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
        <SkeletonBlock className="h-8 w-32" />
      </div>
      <div className="mt-4 space-y-2">
        {ACTIVITY_SKELETON_ROW_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-12 w-full" />
        ))}
      </div>
    </section>
  );
}

export function PaymentsSummaryCardSkeleton({ name }: { name: string }) {
  return (
    <section
      className={skeletonSectionClassName}
      aria-busy="true"
      data-payments-overview-skeleton={name}
    >
      <SkeletonBlock className="h-5 w-36" />
      <SkeletonBlock className="mt-2 h-4 w-52 max-w-full" />
      <SkeletonBlock className="mt-6 h-10 w-full" />
      <SkeletonBlock className="mt-2 h-10 w-full" />
    </section>
  );
}
