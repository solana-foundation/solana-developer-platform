import { SkeletonBlock } from "@/components/ui/skeleton-block";

const API_KEY_ROW_IDS = [
  "api-key-row-1",
  "api-key-row-2",
  "api-key-row-3",
  "api-key-row-4",
  "api-key-row-5",
];

const API_KEY_STEP_IDS = ["api-key-step-1", "api-key-step-2", "api-key-step-3", "api-key-step-4"];

const API_KEY_SUMMARY_ROW_IDS = [
  "api-key-summary-row-1",
  "api-key-summary-row-2",
  "api-key-summary-row-3",
  "api-key-summary-row-4",
  "api-key-summary-row-5",
  "api-key-summary-row-6",
  "api-key-summary-row-7",
  "api-key-summary-row-8",
];

export function ApiKeysListSkeleton() {
  return (
    <div
      className="flex w-full flex-col gap-6"
      data-loading-layout="api-keys-list"
      aria-busy="true"
    >
      <section className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default">
        <header className="grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 sm:grid-cols-[1fr_auto]">
          <SkeletonBlock className="h-6 w-48" />
          <SkeletonBlock className="h-4 w-full max-w-md sm:col-start-1" />
          <SkeletonBlock className="row-span-2 row-start-1 hidden h-10 w-28 rounded-[10px] sm:col-start-2 sm:block" />
        </header>

        <div className="px-6">
          <SkeletonBlock className="mb-4 h-10 w-full rounded-[10px]" />
          <div className="@container/api-keys-table" data-loading-api-key-table>
            <div className="grid grid-cols-[24fr_48fr_18fr] gap-4 border-b border-border-default px-4 py-3 @4xl/api-keys-table:grid-cols-[17fr_10fr_27fr_14fr] @5xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_14fr] @6xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_9fr_14fr] @7xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_9fr_9fr_9fr_11fr]">
              <SkeletonBlock className="h-3 w-12" />
              <SkeletonBlock className="hidden h-3 w-12 @4xl/api-keys-table:block" />
              <SkeletonBlock className="h-3 w-16" />
              <SkeletonBlock className="hidden h-3 w-12 @5xl/api-keys-table:block" />
              <SkeletonBlock className="hidden h-3 w-14 @6xl/api-keys-table:block" />
              <SkeletonBlock className="hidden h-3 w-14 @7xl/api-keys-table:block" />
              <SkeletonBlock className="hidden h-3 w-14 @7xl/api-keys-table:block" />
              <SkeletonBlock className="h-3 w-14" />
            </div>
            <div className="divide-y divide-border-default">
              {API_KEY_ROW_IDS.map((id) => (
                <div
                  key={id}
                  className="grid min-h-16 grid-cols-[24fr_48fr_18fr] items-center gap-4 px-4 py-3 @4xl/api-keys-table:grid-cols-[17fr_10fr_27fr_14fr] @5xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_14fr] @6xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_9fr_14fr] @7xl/api-keys-table:grid-cols-[17fr_10fr_27fr_8fr_9fr_9fr_9fr_11fr]"
                  data-loading-table-row
                >
                  <div className="space-y-2">
                    <SkeletonBlock className="h-4 w-full max-w-28" />
                    <SkeletonBlock className="h-3 w-2/3" />
                  </div>
                  <SkeletonBlock className="hidden h-4 w-16 @4xl/api-keys-table:block" />
                  <div className="min-w-0 space-y-2">
                    <SkeletonBlock className="h-4 w-full max-w-36" />
                    <SkeletonBlock className="h-3 w-4/5" />
                  </div>
                  <SkeletonBlock className="hidden h-5 w-14 rounded-full @5xl/api-keys-table:block" />
                  <SkeletonBlock className="hidden h-4 w-16 @6xl/api-keys-table:block" />
                  <SkeletonBlock className="hidden h-4 w-16 @7xl/api-keys-table:block" />
                  <SkeletonBlock className="hidden h-4 w-16 @7xl/api-keys-table:block" />
                  <SkeletonBlock className="ml-auto size-8 rounded-[10px]" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ApiKeyAuthoringSkeleton({ route }: { route: "api-key-new" | "api-key-edit" }) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-loading-layout={route} aria-busy="true">
      <div className="shrink-0 px-4 pt-2 pb-5 md:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <SkeletonBlock className="h-1.5 w-4 rounded-full" />
              <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
            </div>
            <SkeletonBlock className="h-3 w-20" />
          </div>
          <div className="mt-5 grid grid-cols-4 gap-4 border-b border-border-default pb-2">
            {API_KEY_STEP_IDS.map((id) => (
              <SkeletonBlock key={id} className="mx-auto h-4 w-full max-w-24" />
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto grid w-full max-w-6xl gap-8 pb-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <SkeletonBlock className="h-7 w-52" />
            <SkeletonBlock className="mt-2 h-4 w-full max-w-md" />
            <section className="mt-5 rounded-lg border border-border-default bg-surface-raised p-5">
              <SkeletonBlock className="h-5 w-36" />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <SkeletonBlock className="h-4 w-20" />
                  <SkeletonBlock className="h-10 w-full rounded-lg" />
                </div>
                <div className="space-y-2">
                  <SkeletonBlock className="h-4 w-24" />
                  <SkeletonBlock className="h-10 w-full rounded-lg" />
                </div>
                <div className="space-y-2">
                  <SkeletonBlock className="h-4 w-28" />
                  <SkeletonBlock className="h-10 w-full rounded-lg" />
                </div>
              </div>
            </section>
          </div>

          <aside className="lg:sticky lg:top-4" data-loading-summary-rail>
            <div className="rounded-lg border border-border-default bg-surface-raised p-5">
              <SkeletonBlock className="h-5 w-36" />
              <div className="mt-3 divide-y divide-border-subtle">
                {API_KEY_SUMMARY_ROW_IDS.map((id) => (
                  <div key={id} className="flex items-start gap-2.5 py-2.5">
                    <SkeletonBlock className="size-4 shrink-0" />
                    <SkeletonBlock className="h-4 w-24" />
                    <SkeletonBlock className="ml-auto h-4 w-24" />
                  </div>
                ))}
              </div>
              <SkeletonBlock className="mt-4 h-14 w-full rounded-lg" />
            </div>
          </aside>
        </div>
      </div>

      <div
        className="shrink-0 border-t border-border-default bg-surface-raised px-4 py-4 md:px-6"
        data-loading-action-bar
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}
