import { SkeletonBlock } from "@/components/ui/skeleton-block";

export function CompactOperationsCardSkeleton({ route }: { route: "allowlist" | "members" }) {
  return (
    <div
      className="flex w-full max-w-5xl flex-col gap-6"
      data-loading-layout={route}
      aria-busy="true"
    >
      <section className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default">
        <header className="px-6">
          <SkeletonBlock className="h-6 w-44 max-w-full" />
        </header>
        <div className="px-6">
          <SkeletonBlock className="h-4 w-full max-w-xl" />
          <SkeletonBlock className="mt-2 h-4 w-3/5 max-w-md" />
        </div>
      </section>
    </div>
  );
}

export function SettingsPageSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6" data-loading-layout="settings" aria-busy="true">
      <section className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default">
        <header className="space-y-2 px-6">
          <SkeletonBlock className="h-6 w-56 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-lg" />
        </header>
        <div className="px-6" data-loading-settings-form>
          <div className="w-full max-w-3xl space-y-5">
            <SkeletonBlock className="h-10 w-full rounded-xl" />
            <div className="space-y-2">
              <SkeletonBlock className="h-4 w-32" />
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px] sm:items-center">
                <SkeletonBlock className="h-10 w-full rounded-lg" />
                <SkeletonBlock className="h-10 w-full rounded-[10px]" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
