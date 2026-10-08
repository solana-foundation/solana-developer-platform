import { Card, CardContent } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Mirrors the holdings table: a count line, then four right-aligned columns.
// Without this the route fell through to the dashboard skeleton, which draws the
// home page — a balance hero, an allocation bar and an activity table — none of
// which this page renders.
const HOLDING_ROW_IDS = [
  "holdings-skeleton-1",
  "holdings-skeleton-2",
  "holdings-skeleton-3",
  "holdings-skeleton-4",
  "holdings-skeleton-5",
  "holdings-skeleton-6",
];

export default function TokenHoldingsLoading() {
  return (
    <div className="w-full space-y-4 py-2" data-loading-layout="token-holdings" aria-busy="true">
      <SkeletonBlock className="h-4 w-24 rounded-[4px]" />

      <Card className="min-w-0 overflow-hidden" data-loading-holdings>
        <CardContent className="px-0" data-loading-table>
          <Table className="min-w-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">
                  <SkeletonBlock className="h-4 w-16" />
                </TableHead>
                <TableHead className="text-right">
                  <div className="flex justify-end">
                    <SkeletonBlock className="h-4 w-20" />
                  </div>
                </TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  <div className="flex justify-end">
                    <SkeletonBlock className="h-4 w-12" />
                  </div>
                </TableHead>
                <TableHead className="pr-6 text-right">
                  <div className="flex justify-end">
                    <SkeletonBlock className="h-4 w-16" />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HOLDING_ROW_IDS.map((id) => (
                <TableRow key={id} data-loading-holdings-row>
                  <TableCell className="pl-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <SkeletonBlock className="size-6 shrink-0 rounded-full" />
                      <SkeletonBlock className="h-4 w-20 max-w-full rounded-[4px]" />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end">
                      <SkeletonBlock className="h-4 w-24 max-w-full rounded-[4px]" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <div className="flex justify-end">
                      <SkeletonBlock className="h-4 w-10 max-w-full rounded-[4px]" />
                    </div>
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <div className="flex justify-end">
                      <SkeletonBlock className="h-4 w-20 max-w-full rounded-[4px]" />
                    </div>
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
