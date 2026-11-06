import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";

const LIST_ROW_KEYS = ["first", "second", "third", "fourth", "fifth"];
const ACCESS_ROW_KEYS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const DETAIL_ROW_KEYS = ["prefix", "id", "expires", "created", "ips", "note"];
const WALLET_ROW_KEYS = ["first", "second"];

/** The keys list: the toolbar, the header row and two-line rows, as the page draws them. */
export function ApiKeysListSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      className="flex flex-col gap-5"
      data-loading-layout="api-keys-list"
      aria-busy="true"
    >
      <div className="flex items-center justify-between gap-3">
        <SkeletonBlock className="h-9 w-24 rounded-[10px]" />
        <SkeletonBlock className="h-9 w-56 rounded-[10px]" />
      </div>
      <div>
        <div className="flex h-10 items-center justify-between border-b border-border-subtle">
          <SkeletonBlock className="h-3.5 w-12" />
          <SkeletonBlock className="h-3.5 w-40" />
        </div>
        {LIST_ROW_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-6 border-b border-border-subtle py-3">
            <div className="flex-1 space-y-1.5">
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="h-3.5 w-36" />
            </div>
            <SkeletonBlock className="h-3.5 w-16" />
            <SkeletonBlock className="h-3.5 w-24" />
          </div>
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** The create form's fields in the flow column. */
export function ApiKeyNewSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-flow flex-col gap-8 pt-6"
      data-loading-layout="api-key-new"
      aria-busy="true"
    >
      <div className="space-y-2">
        <SkeletonBlock className="h-3.5 w-12" />
        <SkeletonBlock className="h-10 w-full rounded-[10px]" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-3.5 w-16" />
        <SkeletonBlock className="h-80 w-full rounded-card" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-3.5 w-16" />
        <SkeletonBlock className="h-24 w-full rounded-card" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-3.5 w-14" />
        <SkeletonBlock className="h-10 w-56 rounded-[10px]" />
      </div>
    </div>
  );
}

function RecordRowsSkeleton({ keys }: { keys: string[] }) {
  return (
    <div>
      {keys.map((key) => (
        <div
          key={key}
          className="flex h-10 items-center justify-between border-b border-border-subtle last:border-b-0"
        >
          <SkeletonBlock className="h-3.5 w-20" />
          <SkeletonBlock className="h-4 w-36" />
        </div>
      ))}
    </div>
  );
}

/** A key's page: its facts line, then access, wallets and details, spaced as the record stack. */
export function ApiKeyDetailSkeleton() {
  return (
    <div
      className="flex w-full flex-col gap-12 pt-6 md:gap-20 md:pt-10"
      data-loading-layout="api-key-detail"
      aria-busy="true"
    >
      <SkeletonBlock className="h-4 w-72" />
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-20" />
        <RecordRowsSkeleton keys={ACCESS_ROW_KEYS} />
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-20" />
        <div>
          {WALLET_ROW_KEYS.map((key) => (
            <div
              key={key}
              className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0"
            >
              <SkeletonBlock className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-20" />
        <RecordRowsSkeleton keys={DETAIL_ROW_KEYS} />
      </div>
    </div>
  );
}
