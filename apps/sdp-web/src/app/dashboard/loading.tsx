import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const METRIC_SKELETON_IDS = ["home-metric-skeleton-1", "home-metric-skeleton-2"];
const TABLE_SKELETON_IDS = [
  "home-table-skeleton-1",
  "home-table-skeleton-2",
  "home-table-skeleton-3",
  "home-table-skeleton-4",
  "home-table-skeleton-5",
  "home-table-skeleton-6",
];

export default function DashboardLoading() {
  return (
    <div className="w-full space-y-8 py-2" data-loading-layout="home" aria-busy="true">
      <div className="flex items-center justify-end gap-3">
        <SkeletonBlock className="h-10 w-28 rounded-[10px]" />
        <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {METRIC_SKELETON_IDS.map((id) => (
          <div
            key={id}
            className="rounded-[18px] border border-border-default bg-surface-raised px-6 py-6"
          >
            <SkeletonBlock className="h-4 w-28 rounded-[4px]" />
            <SkeletonBlock className="mt-4 h-9 w-40 rounded-[4px]" />
          </div>
        ))}
      </div>

      <Card className="min-w-0 overflow-hidden bg-surface-raised" data-loading-home-activity>
        <CardHeader
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          data-loading-home-activity-header
        >
          <div className="min-w-0 space-y-2">
            <SkeletonBlock className="h-6 w-52 max-w-full rounded-[4px]" />
            <SkeletonBlock className="h-4 w-72 max-w-full rounded-[4px]" />
          </div>
          <SkeletonBlock className="h-9 w-20 rounded-[10px]" />
        </CardHeader>
        <CardContent className="space-y-3" data-loading-table>
          {TABLE_SKELETON_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-11 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
