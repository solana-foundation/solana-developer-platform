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
      <section className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default">
        <header className="space-y-2 px-6">
          <SkeletonBlock className="h-6 w-56 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-lg" />
        </header>
        <div className="px-6" data-loading-settings-form>
          <div className="w-full space-y-5">
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

      {/* Second card: the settings page also renders members, so a one-card
          skeleton made the layout jump when the real content arrived. */}
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

      {/* Third card: appearance. The block mirrors the segmented theme control's
          geometry — full width until sm, then the fixed 3x6.5rem track plus its gaps,
          padding and border (20.5rem), at the 36px option height inside that padding
          (46px) — so the real card lands in the same box this placeholder occupied.
          The asset-header controls beside it are developer-only, so the settled card
          is this one group for everyone this skeleton renders for. */}
      <section
        className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default"
        data-loading-settings-appearance
      >
        <header className="space-y-2 px-6">
          <SkeletonBlock className="h-6 w-32 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-md" />
        </header>
        <div className="space-y-1.5 px-6">
          <SkeletonBlock className="h-5 w-24" />
          <SkeletonBlock className="h-[46px] w-full rounded-xl sm:w-[20.5rem]" />
          <SkeletonBlock className="h-4 w-full max-w-[20.5rem]" />
        </div>
      </section>
    </div>
  );
}
