import { SkeletonBlock } from "@/components/ui/skeleton-block";

const POLICY_ROW_SKELETON_IDS = [
  "policy-row-skeleton-1",
  "policy-row-skeleton-2",
  "policy-row-skeleton-3",
  "policy-row-skeleton-4",
  "policy-row-skeleton-5",
];
const POLICY_HEADING_SKELETON_IDS = [
  "target",
  "status",
  "default-action",
  "rules",
  "bindings",
  "last-updated",
  "actions",
];
const POLICY_CELL_SKELETON_IDS = ["status", "default-action", "rules", "bindings", "updated"];

export function PoliciesPageSkeleton() {
  return (
    <div className="h-full min-h-0 overflow-hidden px-3 pt-5 pb-6 md:px-6">
      <div className="h-full overflow-hidden rounded-lg border border-border-default bg-white">
        <div className="border-b border-border-default px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
            <div className="flex h-10 items-center gap-6">
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-4 w-20" />
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(240px,1fr)_180px_120px] xl:w-[680px]">
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonBlock className="h-10 w-full" />
            </div>
          </div>
        </div>

        <div className="grid h-[calc(100%-65px)] lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-w-0 p-4">
            <div className="hidden grid-cols-[1.6fr_repeat(5,minmax(5rem,1fr))_2rem] gap-4 lg:grid">
              {POLICY_HEADING_SKELETON_IDS.map((id) => (
                <SkeletonBlock key={`policy-heading-${id}`} className="h-4 w-full" />
              ))}
            </div>
            <div className="mt-4 space-y-4">
              {POLICY_ROW_SKELETON_IDS.map((id) => (
                <div
                  key={id}
                  className="grid grid-cols-[minmax(0,1fr)_3rem] gap-4 border-t border-border-subtle pt-4 lg:grid-cols-[1.6fr_repeat(5,minmax(5rem,1fr))_2rem]"
                >
                  <SkeletonBlock className="h-8 w-full" />
                  <SkeletonBlock className="h-8 w-full" />
                  {POLICY_CELL_SKELETON_IDS.map((cellId) => (
                    <SkeletonBlock
                      key={`${id}-cell-${cellId}`}
                      className="hidden h-5 w-full lg:block"
                    />
                  ))}
                </div>
              ))}
            </div>
          </section>

          <aside className="hidden border-l border-border-default bg-fill-subtle p-5 lg:block">
            <SkeletonBlock className="h-5 w-28" />
            <SkeletonBlock className="mt-3 h-4 w-full" />
            <SkeletonBlock className="mt-2 h-4 w-4/5" />
            <div className="mt-6 space-y-5">
              {POLICY_ROW_SKELETON_IDS.map((id) => (
                <div key={`summary-${id}`} className="flex items-center justify-between gap-4">
                  <SkeletonBlock className="h-4 w-28" />
                  <SkeletonBlock className="h-6 w-8" />
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
