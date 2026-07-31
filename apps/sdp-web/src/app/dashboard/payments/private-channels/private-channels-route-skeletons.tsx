import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

// Stable ids rather than array indices: these lists never reorder, and biome's
// noArrayIndexKey rule applies to skeleton rows the same as real ones.
const DETAIL_ROW_IDS = [
  "pc-skeleton-detail-1",
  "pc-skeleton-detail-2",
  "pc-skeleton-detail-3",
  "pc-skeleton-detail-4",
  "pc-skeleton-detail-5",
  "pc-skeleton-detail-6",
];
const LIST_ROW_IDS = [
  "pc-skeleton-row-1",
  "pc-skeleton-row-2",
  "pc-skeleton-row-3",
  "pc-skeleton-row-4",
  "pc-skeleton-row-5",
];
const FIELD_IDS = ["pc-skeleton-field-1", "pc-skeleton-field-2", "pc-skeleton-field-3"];

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

/** Label/value rows — mirrors the overview's `<dl>` grid. */
export function PrivateChannelsOverviewSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <SkeletonTabs />
      <Card>
        <SkeletonCardHeader />
        <CardContent>
          <div className="divide-y divide-border-subtle">
            {DETAIL_ROW_IDS.map((id) => (
              <div className="flex items-baseline justify-between gap-4 py-3" key={id}>
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-4 w-56" />
              </div>
            ))}
          </div>
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
