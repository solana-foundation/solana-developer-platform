import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function PrivateChannelsPrincipalCreateLoading() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" aria-busy="true">
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-xl">
          <SkeletonBlock className="h-8 w-32" />
        </div>
      </div>
      <div className="min-h-0 flex-1 px-4 md:px-6">
        <div className="mx-auto w-full max-w-xl space-y-6 pb-8">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-48" />
            <SkeletonBlock className="h-4 w-full max-w-md" />
          </div>
          <SkeletonBlock className="h-14 w-full rounded-xl" />
          <SkeletonBlock className="h-14 w-full rounded-xl" />
        </div>
      </div>
      <div className="shrink-0 border-t border-border-default px-4 pt-4 pb-4 md:px-6">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
          <SkeletonBlock className="h-10 w-24 rounded-lg" />
          <SkeletonBlock className="h-10 w-32 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
