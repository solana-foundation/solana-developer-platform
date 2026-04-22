import { SkeletonBlock } from "@/components/ui/skeleton-block";

const FIELD_SKELETON_IDS = [
  "playground-field-skeleton-1",
  "playground-field-skeleton-2",
  "playground-field-skeleton-3",
  "playground-field-skeleton-4",
];
const CODE_SKELETONS = [
  { id: "playground-code-skeleton-1", className: "h-4 w-[92%]" },
  { id: "playground-code-skeleton-2", className: "h-4 w-[68%]" },
  { id: "playground-code-skeleton-3", className: "h-4 w-[92%]" },
  { id: "playground-code-skeleton-4", className: "h-4 w-[68%]" },
  { id: "playground-code-skeleton-5", className: "h-4 w-[92%]" },
  { id: "playground-code-skeleton-6", className: "h-4 w-[68%]" },
  { id: "playground-code-skeleton-7", className: "h-4 w-[92%]" },
  { id: "playground-code-skeleton-8", className: "h-4 w-[68%]" },
];

export function ApiPlaygroundShellSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="grid shrink-0 border-b border-[rgba(28,28,29,0.1)] lg:grid-cols-2">
        <div className="px-6 py-5">
          <SkeletonBlock className="h-11 w-full rounded-[14px]" />
        </div>
        <div className="border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <div className="flex justify-stretch lg:justify-end">
            <SkeletonBlock className="h-11 w-full max-w-[360px] rounded-[14px]" />
          </div>
        </div>
      </div>

      <div className="border-b border-[rgba(28,28,29,0.1)] px-6 py-4 lg:hidden">
        <SkeletonBlock className="h-11 w-full rounded-full" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-b border-[rgba(28,28,29,0.1)] lg:grid lg:grid-cols-2">
        <div className="min-h-0">
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            <div className="space-y-6">
              <div className="space-y-3">
                <SkeletonBlock className="h-6 w-36" />
                <div className="space-y-4">
                  <div className="space-y-2">
                    <SkeletonBlock className="h-4 w-20" />
                    <SkeletonBlock className="h-11 w-full" />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <SkeletonBlock className="h-6 w-32" />
                <div className="space-y-4">
                  {FIELD_SKELETON_IDS.map((id) => (
                    <div key={id} className="space-y-2">
                      <SkeletonBlock className="h-4 w-28" />
                      <SkeletonBlock className="h-11 w-full" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 border-t border-[rgba(28,28,29,0.1)] lg:border-t-0">
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            <SkeletonBlock className="mb-4 h-11 w-full rounded-full" />
            <div className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-[8px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)]">
              <div className="flex-1 space-y-4 px-4 py-5">
                {CODE_SKELETONS.map((skeleton) => (
                  <SkeletonBlock key={skeleton.id} className={skeleton.className} />
                ))}
              </div>
              <div className="border-t border-[rgba(28,28,29,0.1)] px-4 py-3">
                <SkeletonBlock className="h-6 w-28 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid shrink-0 lg:grid-cols-2">
        <div className="flex gap-3 px-6 py-5">
          <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-20 rounded-[10px]" />
        </div>
        <div className="flex gap-3 border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}
