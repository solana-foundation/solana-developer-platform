import { ToolbarSkeleton } from "@/components/dashboard-loading";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

function IssuanceTokenCardSkeleton() {
  return (
    <article className="flex min-h-[340px] flex-col rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <SkeletonBlock className="mb-4 h-14 w-14 rounded-full" />
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="mt-3 h-8 w-3/4" />
      <div className="mt-6 space-y-3 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] p-3">
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
    <div className="w-full space-y-6">
      <ToolbarSkeleton />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <IssuanceTokenCardSkeleton key={`issuance-skeleton-${index + 1}`} />
        ))}
      </div>
    </div>
  );
}
