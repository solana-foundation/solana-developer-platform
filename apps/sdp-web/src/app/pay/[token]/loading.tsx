import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function PublicPayLoading() {
  return (
    <main
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-surface to-surface-sunken px-4 py-12"
      data-loading-layout="public-pay-checkout"
      aria-busy="true"
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-border-subtle bg-surface-raised shadow-[0_24px_70px_-24px_rgba(28,28,29,0.22)]">
        <div className="p-8">
          <div className="flex items-center justify-center border-b border-border-default pb-6">
            <SkeletonBlock className="h-5 w-28" />
          </div>

          <div className="mt-7 flex flex-col items-center space-y-3 text-center">
            <div className="flex items-center justify-center gap-2">
              <SkeletonBlock className="h-3 w-28" />
              <SkeletonBlock className="h-5 w-16 rounded-full" />
            </div>
            <SkeletonBlock className="h-12 w-64 max-w-full" />
          </div>

          <div className="mt-7 flex flex-col items-center gap-5">
            <div className="rounded-2xl border border-border-default bg-[white] p-4">
              <SkeletonBlock className="size-[208px] max-h-[52vw] max-w-[52vw] rounded-lg" />
            </div>
            <SkeletonBlock className="h-4 w-36" />
          </div>

          <div className="mt-8 space-y-3 border-t border-border-default pt-6">
            {[
              ["public-pay-detail-to", "w-28"],
              ["public-pay-detail-token", "w-16"],
              ["public-pay-detail-expiry", "w-32"],
            ].map(([id, width]) => (
              <div key={id} className="flex items-center justify-between gap-4">
                <SkeletonBlock className="h-4 w-14" />
                <SkeletonBlock className={`h-4 ${width}`} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-center border-t border-border-default bg-fill-subtle py-3.5">
          <SkeletonBlock className="h-3 w-40" />
        </div>
      </div>
    </main>
  );
}
