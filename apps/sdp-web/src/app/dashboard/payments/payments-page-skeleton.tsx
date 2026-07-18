import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const BALANCE_SKELETON_IDS = [
  "payments-balance-skeleton-1",
  "payments-balance-skeleton-2",
  "payments-balance-skeleton-3",
];
const TRANSACTION_SKELETON_IDS = [
  "payments-transaction-skeleton-1",
  "payments-transaction-skeleton-2",
  "payments-transaction-skeleton-3",
  "payments-transaction-skeleton-4",
  "payments-transaction-skeleton-5",
];

function PaymentsOverviewSkeleton() {
  return (
    <section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
        <div className="rounded-[4px] bg-fill-subtle px-8 py-10 sm:px-14">
          <SkeletonBlock className="h-5 w-40 rounded-[4px]" />
          <SkeletonBlock className="mt-6 h-14 w-56 rounded-[4px]" />
        </div>
        <div className="grid gap-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-[78px] w-full rounded-[4px]" />
          ))}
        </div>
      </div>
    </section>
  );
}

function PaymentsTransactionsSkeleton() {
  return (
    <section className="rounded-[var(--sdp-surface-radius)] bg-white py-6 shadow-sm ring-1 ring-border-default">
      <div className="space-y-2 px-6">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-4 w-[46%]" />
      </div>
      <div className="mt-6 space-y-3 px-6" data-loading-table>
        {TRANSACTION_SKELETON_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-12 w-full" />
        ))}
      </div>
    </section>
  );
}

export function PaymentsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      className="grid gap-6"
      data-loading-layout="payments-overview"
      aria-busy="true"
    >
      <PaymentsOverviewSkeleton />
      <PaymentsTransactionsSkeleton />
    </DashboardWorkspaceOverviewPanel>
  );
}
