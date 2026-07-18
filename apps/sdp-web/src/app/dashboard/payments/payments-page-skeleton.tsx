import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummaryCardSkeleton,
} from "./payments-command-center-skeletons";

const ACTION_SKELETON_IDS = ["pay", "deposit", "request", "schedule"];

function PaymentsActionsSkeleton() {
  return (
    <section className="rounded-[var(--sdp-surface-radius)] border border-border-default bg-surface-raised p-5">
      <SkeletonBlock className="h-5 w-28" />
      <SkeletonBlock className="mt-2 h-4 w-72 max-w-full" />
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ACTION_SKELETON_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-24 w-full rounded-[var(--sdp-surface-radius)]" />
        ))}
      </div>
    </section>
  );
}

export function PaymentsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      className="grid content-start gap-4"
      data-loading-layout="payments-overview"
      aria-busy="true"
    >
      <PaymentsActionsSkeleton />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.5fr)]">
        <PaymentsBalanceSkeleton />
        <PaymentsActivitySkeleton />
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <PaymentsSummaryCardSkeleton name="upcoming" />
        <PaymentsSummaryCardSkeleton name="network" />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
