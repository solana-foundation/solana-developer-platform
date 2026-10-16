import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsNetworkSkeleton,
  PaymentsUpcomingSkeleton,
} from "./payments-command-center-skeletons";

const ACTION_SKELETON_IDS = ["pay", "deposit", "request", "schedule"];

function PaymentsActionsSkeleton() {
  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-4">
      <SkeletonBlock className="h-5 w-28" />
      <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {ACTION_SKELETON_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-36 w-full rounded-md xl:h-44" />
        ))}
      </div>
    </section>
  );
}

export function PaymentsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      aria-busy="true"
      className="grid content-start gap-4 xl:grid-cols-[minmax(0,1.63fr)_minmax(20rem,1fr)]"
      data-loading-layout="payments-overview"
    >
      <PaymentsActionsSkeleton />
      <PaymentsBalanceSkeleton />
      <PaymentsActivitySkeleton />
      <div className="grid min-w-0 content-start gap-4">
        <PaymentsUpcomingSkeleton />
        <PaymentsNetworkSkeleton />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
