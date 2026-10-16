import { DashboardWorkspaceCard } from "@/components/dashboard-workspace-panel";
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
const CHANNEL_COLUMN_IDS = [
  "pc-skeleton-channel-column-1",
  "pc-skeleton-channel-column-2",
  "pc-skeleton-channel-column-3",
  "pc-skeleton-channel-column-4",
  "pc-skeleton-channel-column-5",
  "pc-skeleton-channel-column-6",
];
const DETAIL_STAT_IDS = [
  "pc-skeleton-detail-stat-1",
  "pc-skeleton-detail-stat-2",
  "pc-skeleton-detail-stat-3",
  "pc-skeleton-detail-stat-4",
];
const SETUP_FIELD_IDS = [
  "pc-skeleton-setup-field-1",
  "pc-skeleton-setup-field-2",
  "pc-skeleton-setup-field-3",
];

/** Card chrome shared by every Private Channels skeleton: title + description. */
function SkeletonCardHeader() {
  return (
    <CardHeader className="space-y-2">
      <SkeletonBlock className="h-5 w-40" />
      <SkeletonBlock className="h-4 w-full max-w-md" />
    </CardHeader>
  );
}

/** Mirrors the Private Channels home: heading, setup action, then a channel directory. */
export function PrivateChannelsOverviewSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <section className="space-y-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="space-y-2">
            <SkeletonBlock className="h-7 w-28" />
            <SkeletonBlock className="h-4 w-80 max-w-full" />
          </div>
          <SkeletonBlock className="h-10 w-32" />
        </div>
        <DashboardWorkspaceCard className="grow-0">
          <div className="overflow-x-auto">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.7fr_2rem] gap-4 border-border-default border-y bg-fill-subtle px-4 py-3">
                {CHANNEL_COLUMN_IDS.map((id) => (
                  <SkeletonBlock className="h-3 w-16" key={`pc-skeleton-channel-heading-${id}`} />
                ))}
              </div>
              {LIST_ROW_IDS.slice(0, 3).map((id) => (
                <div
                  className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.7fr_2rem] items-center gap-4 border-border-default border-b px-4 py-4"
                  key={`pc-skeleton-channel-${id}`}
                >
                  <SkeletonBlock className="h-4 w-24" />
                  <SkeletonBlock className="h-4 w-20" />
                  <SkeletonBlock className="h-4 w-16" />
                  <SkeletonBlock className="h-4 w-16" />
                  <SkeletonBlock className="h-5 w-20 rounded-full" />
                  <SkeletonBlock className="h-4 w-4 justify-self-end" />
                </div>
              ))}
            </div>
          </div>
        </DashboardWorkspaceCard>
      </section>
    </div>
  );
}

/** Stacked rows inside a bordered list — channels, events, verified wallets. */
export function PrivateChannelsListSkeleton({ maxWidth = "max-w-3xl" }: { maxWidth?: string }) {
  return (
    <div className={`mx-auto w-full ${maxWidth}`}>
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

/** Mirrors a selected channel: summary, wallets, and token details. */
export function PrivateChannelDetailSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col justify-between gap-5 p-6 lg:flex-row lg:items-start">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <SkeletonBlock className="h-8 w-40" />
              <SkeletonBlock className="h-5 w-20 rounded-full" />
            </div>
            <SkeletonBlock className="h-4 w-96 max-w-full" />
          </div>
          <SkeletonBlock className="h-9 w-28" />
        </div>

        <div className="grid gap-px border-border-default border-t bg-border-default sm:grid-cols-2 lg:grid-cols-4">
          {DETAIL_STAT_IDS.map((id) => (
            <div className="space-y-2 bg-surface-raised px-6 py-4" key={id}>
              <SkeletonBlock className="h-3 w-24" />
              <SkeletonBlock className="h-4 w-32 max-w-full" />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <SkeletonBlock className="h-6 w-20" />
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border border-border-default">
            <div className="grid grid-cols-[1fr_2rem] gap-4 border-border-default border-b bg-fill-subtle px-4 py-3">
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="h-4 w-4 justify-self-end" />
            </div>
            {LIST_ROW_IDS.slice(0, 3).map((id) => (
              <div
                className="grid grid-cols-[1fr_2rem] items-center gap-4 border-border-default border-b px-4 py-4 last:border-b-0"
                key={id}
              >
                <div className="flex items-center gap-3">
                  <SkeletonBlock className="size-8 rounded-full" />
                  <div className="space-y-2">
                    <SkeletonBlock className="h-4 w-32" />
                    <SkeletonBlock className="h-3 w-44" />
                  </div>
                </div>
                <SkeletonBlock className="size-5 justify-self-end" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-2">
          <SkeletonBlock className="h-6 w-52" />
          <SkeletonBlock className="h-4 w-80 max-w-full" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-5 rounded-lg border border-border-default p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3 sm:min-w-48">
              <SkeletonBlock className="size-10 rounded-full" />
              <div className="space-y-2">
                <SkeletonBlock className="h-5 w-16" />
                <SkeletonBlock className="h-4 w-14" />
              </div>
            </div>
            <div className="grid grow grid-cols-2 gap-6">
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-10" />
                <SkeletonBlock className="h-5 w-32" />
              </div>
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-16" />
                <SkeletonBlock className="h-5 w-8" />
              </div>
            </div>
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

/** Mirrors the single-step, full-page connection flow. */
export function PrivateChannelsSetupSkeleton() {
  return (
    <div
      className="-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 flex-col md:-mx-6 xl:-mb-6"
      data-loading-wizard
      aria-busy="true"
    >
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-4">
          <SkeletonBlock className="h-1.5 w-5 rounded-full" />
          <SkeletonBlock className="h-3 w-16" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 md:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-6 pb-8">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-52 max-w-full" />
            <SkeletonBlock className="h-4 w-full max-w-2xl" />
          </div>
          {SETUP_FIELD_IDS.slice(0, 2).map((id) => (
            <div className="space-y-2" key={id}>
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-14 w-full rounded-xl" />
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-2">
            {SETUP_FIELD_IDS.slice(2).map((id) => (
              <div className="space-y-2" key={id}>
                <SkeletonBlock className="h-4 w-32" />
                <SkeletonBlock className="h-14 w-full rounded-xl" />
              </div>
            ))}
            <div className="space-y-2">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-14 w-full rounded-xl" />
            </div>
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-4 w-36" />
            <SkeletonBlock className="h-14 w-full rounded-xl" />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <SkeletonBlock className="h-10 w-24 rounded-lg" />
          <div className="flex gap-3">
            <SkeletonBlock className="h-10 w-36 rounded-lg" />
            <SkeletonBlock className="h-10 w-24 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
