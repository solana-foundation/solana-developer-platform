import { WalletActivitySkeleton } from "@/app/dashboard/[projectId]/custody/wallet-activity-skeleton";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { cn } from "@/lib/utils";

const THREE_ITEMS = ["one", "two", "three"] as const;
const FOUR_ITEMS = ["one", "two", "three", "four"] as const;
const FIVE_ITEMS = ["one", "two", "three", "four", "five"] as const;
function Pulse({ className }: { className?: string }) {
  return <SkeletonBlock className={cn("motion-reduce:animate-none", className)} />;
}

function LoadingRegion({
  children,
  className,
  layout,
}: {
  children: React.ReactNode;
  className?: string;
  layout: string;
}) {
  return (
    <div aria-busy="true" className={className} data-wallet-loading-layout={layout}>
      {children}
    </div>
  );
}

function MetadataRows({ count = 4 }: { count?: 3 | 4 }) {
  const rows = count === 3 ? THREE_ITEMS : FOUR_ITEMS;
  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
      {rows.map((row) => (
        <div
          key={row}
          className="flex min-h-11 items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
        >
          <Pulse className="h-4 w-24" />
          <Pulse className="h-4 w-36 sm:w-44" />
        </div>
      ))}
    </div>
  );
}

function WalletCardSkeleton() {
  return (
    <article className="flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Pulse className="size-14 rounded-full" />
          <div>
            <Pulse className="h-3 w-20" />
            <Pulse className="mt-2 h-7 w-36" />
          </div>
        </div>
        <Pulse className="h-6 w-20" />
      </div>
      <div className="mt-5 space-y-1.5">
        <div className="flex h-6 items-center justify-between gap-3">
          <Pulse className="h-3 w-14" />
          <Pulse className="h-3 w-28" />
        </div>
        <div className="flex h-6 items-center justify-between gap-3">
          <Pulse className="h-3 w-16" />
          <Pulse className="h-3 w-32" />
        </div>
      </div>
    </article>
  );
}

export function WalletsOverviewSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <LoadingRegion layout="wallets-overview" className="space-y-6">
        <div
          className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          data-wallet-search-skeleton
        >
          <Pulse className="h-10 w-full rounded-lg sm:max-w-md" />
          <Pulse className="h-10 w-full rounded-lg sm:w-36" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {THREE_ITEMS.map((item) => (
            <WalletCardSkeleton key={item} />
          ))}
        </div>
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function WalletsOnboardingSkeleton() {
  return (
    <LoadingRegion layout="wallets-onboarding">
      <section className="rounded-[24px] border border-border-subtle bg-surface-raised">
        <div className="space-y-3 border-b border-border-subtle px-6 py-5">
          <Pulse className="h-6 w-64 max-w-full" />
          <Pulse className="h-4 w-[min(34rem,80%)]" />
        </div>
        <div className="space-y-4 p-6">
          <MetadataRows count={3} />
          <Pulse className="h-4 w-[min(38rem,90%)]" />
        </div>
      </section>
    </LoadingRegion>
  );
}

export function WalletSetupSkeleton() {
  return (
    <LoadingRegion layout="wallet-setup" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Pulse className="h-1.5 w-5 rounded-full" />
            <Pulse className="h-1.5 w-2.5 rounded-full" />
          </div>
          <Pulse className="h-3 w-16" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-4 md:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-6 pb-8">
          <Pulse className="h-8 w-56" />
          <div className="grid gap-4">
            {FIVE_ITEMS.map((provider) => (
              <div
                key={provider}
                className="w-full rounded-2xl border border-border-default bg-surface-raised px-5 py-5"
              >
                <div className="flex items-start gap-4">
                  <Pulse className="size-11 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                    <Pulse className="h-6 w-48 max-w-full" />
                    <Pulse className="h-4 w-full max-w-[42rem]" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <Pulse className="h-10 w-24 rounded-lg" />
          <Pulse className="h-10 w-28 rounded-lg" />
        </div>
      </div>
    </LoadingRegion>
  );
}

function WalletSummaryCardSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="space-y-6 p-6">
        <div className="flex items-start gap-4">
          {!compact ? <Pulse className="size-14 shrink-0 rounded-full" /> : null}
          <div className="min-w-0 flex-1 space-y-2">
            <Pulse className={compact ? "h-3 w-28" : "h-9 w-56 max-w-full"} />
            <Pulse className={compact ? "h-10 w-36" : "h-4 w-28"} />
          </div>
        </div>
        <MetadataRows count={compact ? 3 : 4} />
      </div>
    </section>
  );
}

export function WalletBalanceSummarySkeleton() {
  return <WalletSummaryCardSkeleton compact />;
}

export function WalletBalancesSkeleton() {
  return (
    <section className="space-y-3" data-skeleton-section="wallet-balances">
      <Pulse className="h-10 w-36" />
      <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        {THREE_ITEMS.map((row) => (
          <div
            key={row}
            className="flex min-h-[58px] items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
          >
            <div className="space-y-2">
              <Pulse className="h-5 w-20" />
              <Pulse className="h-3 w-48 sm:w-56" />
            </div>
            <Pulse className="h-4 w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function WalletDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <LoadingRegion layout="wallet-detail" className="space-y-6">
        <div className="flex justify-end">
          <Pulse className="h-9 w-[132px] rounded-lg" />
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <WalletSummaryCardSkeleton />
          <WalletBalanceSummarySkeleton />
        </div>
        <WalletBalancesSkeleton />
        <WalletActivitySkeleton />
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function WalletConnectionsListSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col">
      <LoadingRegion layout="wallet-connections" className="flex w-full flex-1 flex-col">
        <DashboardWorkspaceCard>
          <div
            className="flex flex-col gap-3 border-b border-border-default p-4 sm:flex-row sm:items-center sm:justify-between"
            data-loading-connections-toolbar
          >
            <Pulse className="h-4 w-72 max-w-full" />
            <Pulse className="h-9 w-full rounded-lg sm:w-40" />
          </div>
          <div className="flex-1 space-y-3 p-4" data-loading-connections-rows>
            {FIVE_ITEMS.map((row) => (
              <Pulse key={row} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        </DashboardWorkspaceCard>
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}
