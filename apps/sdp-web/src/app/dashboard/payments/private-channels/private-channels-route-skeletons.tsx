import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

// Stable ids rather than array indices: these lists never reorder, and biome's
// noArrayIndexKey rule applies to skeleton rows the same as real ones.
const LIST_ROW_IDS = [
  "pc-skeleton-row-1",
  "pc-skeleton-row-2",
  "pc-skeleton-row-3",
  "pc-skeleton-row-4",
  "pc-skeleton-row-5",
];
const FIELD_IDS = ["pc-skeleton-field-1", "pc-skeleton-field-2", "pc-skeleton-field-3"];
const PANEL_IDS = ["pc-skeleton-panel-1", "pc-skeleton-panel-2", "pc-skeleton-panel-3"];

/** Card chrome shared by every Private Channels skeleton: title + description. */
function SkeletonCardHeader() {
  return (
    <CardHeader className="space-y-2">
      <SkeletonBlock className="h-5 w-40" />
      <SkeletonBlock className="h-4 w-full max-w-md" />
    </CardHeader>
  );
}

/** The tab strip is rendered by the segment layout, which loads with the page. */
function SkeletonTabs() {
  return (
    <div className="mb-6 flex gap-6 border-border-default border-b pb-3">
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="h-4 w-14" />
      <SkeletonBlock className="h-4 w-16" />
    </div>
  );
}

/** Three summary panels over the activity and wallets tables. */
export function PrivateChannelsOverviewSkeleton() {
  return (
    <div className="h-full min-h-0 w-full space-y-4 overflow-y-auto px-3 pt-2 pb-5 md:px-6 md:pb-6">
      <SkeletonTabs />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {PANEL_IDS.map((id) => (
          <Card className="h-full" key={id}>
            <CardHeader>
              <SkeletonBlock className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <SkeletonBlock className="h-5 w-52" />
        </CardHeader>
        <CardContent className="space-y-2">
          {LIST_ROW_IDS.map((id) => (
            <SkeletonBlock className="h-9 w-full" key={`pc-skeleton-activity-${id}`} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/** Stacked rows inside a bordered list — channels, events, verified wallets. */
export function PrivateChannelsListSkeleton({ maxWidth = "max-w-3xl" }: { maxWidth?: string }) {
  return (
    <div className={`mx-auto w-full ${maxWidth}`}>
      <SkeletonTabs />
      <Card>
        <SkeletonCardHeader />
        <CardContent>
          <div className="divide-y divide-border-default rounded-lg border border-border-default">
            {LIST_ROW_IDS.map((id) => (
              <div className="flex flex-col gap-2 px-4 py-3" key={id}>
                <div className="flex items-center gap-2">
                  <SkeletonBlock className="h-4 w-20" />
                  <SkeletonBlock className="h-4 w-40" />
                </div>
                <SkeletonBlock className="h-3 w-32" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Label + input pairs with a submit button — deposit, withdraw, connect. */
export function PrivateChannelsFormSkeleton({ maxWidth = "max-w-2xl" }: { maxWidth?: string }) {
  return (
    <div className={`mx-auto w-full ${maxWidth}`}>
      <SkeletonTabs />
      <Card>
        <SkeletonCardHeader />
        <CardContent className="space-y-4">
          {FIELD_IDS.map((id) => (
            <div className="space-y-2" key={id}>
              <SkeletonBlock className="h-3.5 w-24" />
              <SkeletonBlock className="h-10 w-full" />
            </div>
          ))}
          <SkeletonBlock className="h-10 w-32" />
        </CardContent>
      </Card>
    </div>
  );
}
