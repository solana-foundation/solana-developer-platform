import { SkeletonBlock } from "@/components/ui/skeleton-block";

/**
 * Mirrors the detail page's card stack — header, wallets, credentials — so the
 * layout does not jump when the reads land.
 */
export default function CustodyConnectionLoading() {
  return (
    <div className="w-full space-y-6 px-4 py-6 md:px-6" aria-busy="true">
      <div className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <div className="flex items-start gap-4">
          <SkeletonBlock className="size-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <SkeletonBlock className="h-6 w-56" />
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-4 w-64" />
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <SkeletonBlock className="h-5 w-24" />
        <div className="mt-4 space-y-3">
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
        </div>
      </div>
      <div className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <SkeletonBlock className="h-5 w-28" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <SkeletonBlock className="h-40 w-full rounded-xl" />
          <SkeletonBlock className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
