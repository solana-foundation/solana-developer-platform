import { SkeletonBlock } from "@/components/ui/skeleton-block";

export function PaymentsActionPageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 py-6">
      <div className="space-y-6">
        <SkeletonBlock className="h-[2px] w-full rounded-full" />
        <div className="space-y-3 text-center">
          <SkeletonBlock className="mx-auto h-12 w-48 rounded-[8px]" />
          <SkeletonBlock className="mx-auto h-5 w-96 max-w-full rounded-[8px]" />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="space-y-3 text-center">
          <SkeletonBlock className="mx-auto h-10 w-72 rounded-[8px]" />
          <SkeletonBlock className="mx-auto h-5 w-[28rem] max-w-full rounded-[8px]" />
        </div>

        <div className="grid gap-4">
          <SkeletonBlock className="h-28 w-full rounded-[24px]" />
          <SkeletonBlock className="h-28 w-full rounded-[24px]" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row-reverse">
        <SkeletonBlock className="h-14 flex-1 rounded-full" />
        <SkeletonBlock className="h-14 flex-1 rounded-full" />
      </div>
    </div>
  );
}
