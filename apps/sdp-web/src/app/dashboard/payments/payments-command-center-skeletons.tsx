import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_SKELETON_ROW_IDS = ["one", "two"];
const ACTIVITY_SKELETON_ROW_IDS = ["one", "two", "three", "four", "five"];
const ACTION_SKELETON_IDS = ["pay", "deposit", "request", "schedule"];

export function PaymentsBalanceSkeleton() {
  return (
    <section className="min-w-0" aria-busy="true" data-payments-overview-skeleton="balance">
      <SkeletonBlock className="h-5 w-32" />
      <SkeletonBlock className="mt-1 h-11 w-48" />
      <div className="mt-8 space-y-2">
        {BALANCE_SKELETON_ROW_IDS.map((id) => (
          <div key={id} className="flex items-center gap-4">
            <SkeletonBlock className="size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <SkeletonBlock className="h-5 w-14" />
              <SkeletonBlock className="h-4 w-20" />
            </div>
            <SkeletonBlock className="h-5 w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function PaymentsSummarySkeleton() {
  return (
    <section
      className="mt-9 border-t border-border-default pt-6"
      aria-busy="true"
      data-payments-overview-skeleton="summary"
    >
      <SkeletonBlock className="h-6 w-full max-w-md" />
    </section>
  );
}

export function PaymentsActionsSkeleton() {
  return (
    <section className="grid min-w-0 grid-cols-2 content-start gap-2">
      {ACTION_SKELETON_IDS.map((id) => (
        <SkeletonBlock key={id} className="h-[120px] w-full rounded-control" />
      ))}
    </section>
  );
}

export function PaymentsActivitySkeleton() {
  return (
    <section className="min-w-0" aria-busy="true" data-payments-overview-skeleton="activity">
      <div className="flex items-center justify-between gap-4">
        <SkeletonBlock className="h-6 w-24" />
        <SkeletonBlock className="h-8 w-44 rounded-control" />
      </div>
      <div className="mt-4 divide-y divide-border-subtle">
        {ACTIVITY_SKELETON_ROW_IDS.map((id) => (
          <div key={id} className="flex items-center justify-between gap-4 py-2">
            <div className="space-y-1.5">
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="h-4 w-40" />
            </div>
            <div className="flex flex-col items-end space-y-1.5">
              <SkeletonBlock className="h-5 w-28" />
              <SkeletonBlock className="h-4 w-8" />
            </div>
          </div>
        ))}
      </div>
      <SkeletonBlock className="mt-6 h-9 w-44 rounded-control" />
    </section>
  );
}
