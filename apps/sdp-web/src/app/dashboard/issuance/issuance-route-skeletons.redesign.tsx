import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { DesignSwitch } from "@/components/new-design";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { cn } from "@/lib/utils";
import { IssuanceCreateSkeleton as LegacyIssuanceCreateSkeleton } from "./issuance-create-skeleton";
import { IssuanceDetailSkeleton as LegacyIssuanceDetailSkeleton } from "./issuance-detail-skeleton";
import { IssuancePageSkeleton as LegacyIssuancePageSkeleton } from "./issuance-page-skeleton";

const ROWS = ["one", "two", "three", "four", "five", "six"] as const;
const RECORD_ROWS = ["one", "two", "three"] as const;
const COLUMNS = ["left", "right"] as const;

function Pulse({ className }: { className?: string }) {
  return <SkeletonBlock className={cn("motion-reduce:animate-none", className)} />;
}

/** The list's rows while a search, filter or sort is on its way. */
export function IssuanceListRowsSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col" data-issuance-loading-layout="rows">
      {ROWS.map((row) => (
        <div
          key={row}
          className="grid grid-cols-[36px_minmax(0,1fr)_max-content] items-center gap-x-3 border-b border-border-subtle py-4.25"
        >
          <Pulse className="size-9 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Pulse className="h-4 w-48 max-w-full" />
            <Pulse className="h-3.5 w-24" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Pulse className="h-3 w-14" />
            <Pulse className="h-4 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Both Issuance pages scroll in the workspace's panel, so their skeletons sit in it too. */
function CurrentIssuancePageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="flex flex-col gap-4" data-issuance-loading-layout="list">
        <div className="flex items-center justify-between gap-3">
          <Pulse className="h-9 w-24" />
          <Pulse className="hidden h-9 w-56 sm:block" />
        </div>
        <IssuanceListRowsSkeleton />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

function CurrentIssuanceDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel>
      <div
        aria-busy="true"
        className="flex flex-col gap-8 md:gap-16"
        data-issuance-loading-layout="token"
      >
        <Pulse className="h-16 w-full rounded-card" />
        <div className="flex flex-col gap-4">
          <Pulse className="h-3.5 w-24" />
          <Pulse className="h-10 w-40" />
          <div className="grid gap-x-12 md:grid-cols-2">
            {COLUMNS.map((column) => (
              <div key={column}>
                {RECORD_ROWS.map((row) => (
                  <div
                    key={row}
                    className="flex min-h-10 items-center justify-between border-b border-border-subtle py-2.5"
                  >
                    <Pulse className="h-3.5 w-24" />
                    <Pulse className="h-4 w-28" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

function CurrentIssuanceCreateSkeleton() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-flow flex-col gap-12 px-4 pt-9 md:px-0"
      data-issuance-loading-layout="flow"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-between">
          <Pulse className="h-5 w-24" />
          <Pulse className="h-4 w-20" />
        </div>
        <Pulse className="h-1 w-full rounded-full" />
      </div>
      <div className="flex flex-col gap-6">
        <Pulse className="h-8 w-64" />
        <Pulse className="h-14 w-full" />
        <Pulse className="h-20 w-full rounded-card" />
        <Pulse className="h-20 w-full rounded-card" />
      </div>
    </div>
  );
}

export function IssuancePageSkeleton() {
  return (
    <DesignSwitch
      designModule="issuance"
      current={<CurrentIssuancePageSkeleton />}
      legacy={<LegacyIssuancePageSkeleton assetProfilesEnabled />}
    />
  );
}

export function IssuanceDetailSkeleton() {
  return (
    <DesignSwitch
      designModule="issuance"
      current={<CurrentIssuanceDetailSkeleton />}
      legacy={<LegacyIssuanceDetailSkeleton />}
    />
  );
}

export function IssuanceCreateSkeleton() {
  return (
    <DesignSwitch
      designModule="issuance"
      current={<CurrentIssuanceCreateSkeleton />}
      legacy={<LegacyIssuanceCreateSkeleton />}
    />
  );
}

export {
  CurrentIssuanceCreateSkeleton,
  CurrentIssuanceDetailSkeleton,
  CurrentIssuancePageSkeleton,
};
