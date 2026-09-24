import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import {
  PaymentsActionsSkeleton,
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummarySkeleton,
} from "./payments-command-center-skeletons";

export function PaymentsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      aria-busy="true"
      className="flex min-w-0 flex-col gap-16 pt-4"
      data-loading-layout="payments-overview"
    >
      <div className="grid min-w-0 gap-10 lg:grid-cols-2 lg:gap-12">
        <div className="min-w-0">
          <PaymentsBalanceSkeleton />
          <PaymentsSummarySkeleton />
        </div>
        <PaymentsActionsSkeleton />
      </div>
      <PaymentsActivitySkeleton />
    </DashboardWorkspaceOverviewPanel>
  );
}
