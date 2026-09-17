import { Skeleton } from "@/components/ui/skeleton";

export function DashboardSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-8 sm:px-8 sm:py-10 xl:py-12">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="size-8 rounded-lg" />
      </div>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-14 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36 rounded-lg" />
          <Skeleton className="h-9 w-36 rounded-lg" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {["checking", "savings"].map((account) => (
          <div
            key={account}
            className="flex flex-col gap-6 rounded-2xl border p-5"
          >
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </div>
  );
}
