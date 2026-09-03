import { SkeletonBlock } from "@/components/ui/skeleton-block";

export function CompactOperationsCardSkeleton({ route }: { route: "allowlist" }) {
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
      {/* The organization/RPC card moved to Integrations (HOO-787); the page
          opens on members now, so reserving a first card here would leave a
          gap that never fills. */}
      <section
        className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default"
        data-loading-settings-members
      >
        <header className="space-y-2 px-6">
          <SkeletonBlock className="h-6 w-40 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-md" />
        </header>
        <div className="space-y-5 px-6">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
            <div className="space-y-2">
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-10 w-full rounded-lg" />
            </div>
            <div className="space-y-2">
              <SkeletonBlock className="h-4 w-12" />
              <SkeletonBlock className="h-10 w-full rounded-lg" />
            </div>
            <SkeletonBlock className="h-10 w-full rounded-[10px] sm:w-28" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-9 w-full rounded-lg" />
            <SkeletonBlock className="h-14 w-full rounded-lg" />
            <SkeletonBlock className="h-14 w-full rounded-lg" />
          </div>
        </div>
      </section>
    </div>
  );
}
