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
        <div className="rounded-[4px] bg-[rgba(28,28,29,0.04)] px-8 py-10 sm:px-14">
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
    <section className="rounded-3xl border border-[rgba(28,28,29,0.1)] bg-white/85 p-5 shadow-[0_12px_32px_rgba(28,28,29,0.04)] animate-pulse">
      <div className="space-y-3">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-4 w-[46%]" />
      </div>
      <div className="mt-6 space-y-3">
        {TRANSACTION_SKELETON_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-12 w-full" />
        ))}
      </div>
    </section>
  );
}

export function PaymentsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="grid gap-6">
      <div className="flex flex-wrap gap-3">
        <SkeletonBlock className="h-10 w-24 rounded-full" />
        <SkeletonBlock className="h-10 w-28 rounded-full" />
      </div>
      <PaymentsOverviewSkeleton />
      <PaymentsTransactionsSkeleton />
    </DashboardWorkspaceOverviewPanel>
  );
}
