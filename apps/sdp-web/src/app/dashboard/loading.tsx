import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function DashboardLoading() {
  return (
    <div className="w-full space-y-8 py-2">
      <div className="flex items-center justify-end gap-3">
        <SkeletonBlock className="h-10 w-28 rounded-[10px]" />
        <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div
            key={`home-metric-skeleton-${index + 1}`}
            className="rounded-[18px] border border-[rgba(28,28,29,0.1)] bg-white px-6 py-6"
          >
            <SkeletonBlock className="h-4 w-28 rounded-[4px]" />
            <SkeletonBlock className="mt-4 h-9 w-40 rounded-[4px]" />
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-52 rounded-[4px]" />
            <SkeletonBlock className="h-4 w-72 rounded-[4px]" />
          </div>
          <SkeletonBlock className="h-9 w-20 rounded-[10px]" />
        </div>

        <div className="rounded-[20px] border border-[rgba(28,28,29,0.1)] bg-white p-6">
          <div className="space-y-3">
            {Array.from({ length: 6 }, (_, index) => (
              <SkeletonBlock key={`home-table-skeleton-${index + 1}`} className="h-11 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
