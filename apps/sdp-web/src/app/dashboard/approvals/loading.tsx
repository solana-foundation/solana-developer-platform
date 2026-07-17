import { SkeletonBlock } from "@/components/ui/skeleton-block";

const FILTER_SKELETON_KEYS = ["wallet", "operation", "api-key", "from", "to", "actions"];

export default function ApprovalsLoading() {
  return (
    <div className="h-full overflow-hidden px-3 py-6 md:px-6">
      <div className="mx-auto w-full max-w-[1500px] space-y-6">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-64" />
          <SkeletonBlock className="h-4 w-96 max-w-full" />
        </div>
        <SkeletonBlock className="h-10 w-52" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-6">
          {FILTER_SKELETON_KEYS.map((key) => (
            <SkeletonBlock key={key} className="h-16" />
          ))}
        </div>
        <SkeletonBlock className="h-72" />
      </div>
    </div>
  );
}
