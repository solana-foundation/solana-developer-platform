import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function CounterpartyLoading() {
  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <SkeletonBlock className="h-5 w-32" />
      <SkeletonBlock className="h-4 w-64" />
      <div className="space-y-3">
        {[...Array(5).keys()].map((n) => (
          <SkeletonBlock key={n} className="h-10 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
