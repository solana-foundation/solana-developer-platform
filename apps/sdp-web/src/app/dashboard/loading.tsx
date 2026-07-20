import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const METRIC_SKELETON_IDS = ["home-metric-skeleton-1", "home-metric-skeleton-2"];
const ACTIVITY_ROW_IDS = [
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
        <CardContent data-loading-table data-loading-home-activity-table>
          <Table className="min-w-0 [&_table]:table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[8rem] pl-6" data-loading-home-activity-column="time">
                  <SkeletonBlock className="h-4 w-16" />
                </TableHead>
                <TableHead
                  className="w-[calc(100%_-_8rem)] md:hidden"
                  data-loading-home-activity-column="activity"
                >
                  <SkeletonBlock className="h-4 w-20" />
                </TableHead>
                <TableHead
                  className="hidden w-[10rem] md:table-cell"
                  data-loading-home-activity-column="type"
                >
                  <SkeletonBlock className="h-4 w-16" />
                </TableHead>
                <TableHead
                  className="hidden w-[8rem] md:table-cell"
                  data-loading-home-activity-column="token"
                >
                  <SkeletonBlock className="h-4 w-16" />
                </TableHead>
                <TableHead
                  className="hidden w-[10rem] md:table-cell"
                  data-loading-home-activity-column="amount"
                >
                  <SkeletonBlock className="h-4 w-20" />
                </TableHead>
                <TableHead
                  className="hidden pr-6 md:table-cell"
                  data-loading-home-activity-column="address"
                >
                  <SkeletonBlock className="h-4 w-24" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ACTIVITY_ROW_IDS.map((id) => (
                <TableRow key={id} data-loading-home-activity-row>
                  <TableCell className="pl-6">
                    <SkeletonBlock className="h-4 w-16 max-w-full" />
                  </TableCell>
                  <TableCell className="min-w-0 md:hidden">
                    <div className="min-w-0" data-loading-home-mobile-activity>
                      <SkeletonBlock className="h-4 w-24 max-w-full" />
                      <SkeletonBlock className="mt-1 h-3 w-20 max-w-full" />
                      <SkeletonBlock className="mt-1 h-3 w-32 max-w-full" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <SkeletonBlock className="h-4 w-24 max-w-full" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <SkeletonBlock className="h-4 w-16 max-w-full" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <SkeletonBlock className="h-4 w-24 max-w-full" />
                  </TableCell>
                  <TableCell className="hidden pr-6 md:table-cell">
                    <SkeletonBlock className="h-3 w-32 max-w-full" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
