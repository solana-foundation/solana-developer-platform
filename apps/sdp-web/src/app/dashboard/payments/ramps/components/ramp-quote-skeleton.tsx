import { SkeletonBlock } from "@/components/ui/skeleton-block";

export function RampQuoteSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <SkeletonBlock className="size-10 shrink-0 rounded-xl" />
        <div className="flex-1 space-y-2 pt-1">
          <SkeletonBlock className="h-4 w-48" />
          <SkeletonBlock className="h-3.5 w-full max-w-md" />
        </div>
      </div>
      <div className="mt-6 space-y-3">
        <SkeletonBlock className="h-16 rounded-xl" />
        <SkeletonBlock className="h-16 rounded-xl" />
      </div>
      <div className="mt-6 border-t border-border-light pt-5">
        <SkeletonBlock className="h-4 w-40" />
      </div>
    </div>
  );
}
