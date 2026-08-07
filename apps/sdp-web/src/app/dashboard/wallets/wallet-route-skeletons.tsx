import { WalletActivitySkeleton } from "@/app/dashboard/custody/wallet-activity-skeleton";
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
    <article className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5">
      <Pulse className="size-14 rounded-full" />
      <Pulse className="mt-4 h-3 w-20" />
      <Pulse className="mt-2 h-8 w-40" />
      <div className="mt-6 space-y-3 rounded-xl border border-border-subtle bg-fill-subtle p-3">
        {FOUR_ITEMS.map((row) => (
          <div key={row} className="flex items-center justify-between gap-4">
            <Pulse className="h-3.5 w-16" />
            <Pulse className="h-3.5 w-24" />
          </div>
        ))}
      </div>
      <div className="mt-auto pt-3">
        <Pulse className="h-11 w-full rounded-[10px]" />
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
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6">
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

export function WalletControlsSkeleton() {
  return (
    <section
      className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
      data-skeleton-section="wallet-controls"
    >
      <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <Pulse className="h-7 w-44" />
          <Pulse className="h-4 w-full max-w-2xl" />
          <div className="grid gap-2 sm:grid-cols-3">
            {THREE_ITEMS.map((metric) => (
              <div
                key={metric}
                className="space-y-2 rounded-lg border border-border-subtle bg-fill-subtle px-3 py-2"
              >
                <Pulse className="h-3 w-20" />
                <Pulse className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
          <Pulse className="h-10 w-full rounded-lg sm:w-36" />
          <Pulse className="h-10 w-full rounded-lg sm:w-40" />
        </div>
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
        <WalletControlsSkeleton />
        <WalletBalancesSkeleton />
        <WalletActivitySkeleton />
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function WalletPolicySkeleton() {
  return (
    <LoadingRegion
      layout="wallet-policy"
      className="flex h-full min-h-0 flex-col bg-surface-raised"
    >
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6" data-wizard-stepper>
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-1.5">
              <Pulse className="h-1.5 w-5 rounded-full" />
              {THREE_ITEMS.map((step) => (
                <Pulse key={step} className="h-1.5 w-2.5 rounded-full" />
              ))}
            </div>
            <Pulse className="h-3 w-16" />
          </div>
          <Pulse className="ml-auto h-9 w-38 rounded-lg" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" data-wizard-scroll-region>
        <div className="mx-auto w-full max-w-6xl pb-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px]">
            <main className="min-w-0" data-skeleton-section="policy-form">
              <div className="mb-6 space-y-2">
                <Pulse className="h-7 w-64 max-w-full" />
                <Pulse className="h-4 w-full max-w-2xl" />
              </div>
              <div className="space-y-4">
                <Pulse className="h-32 w-full rounded-lg" />
                <Pulse className="h-48 w-full rounded-lg" />
              </div>
            </main>
            <aside
              className="h-fit space-y-4 rounded-lg border border-border-default bg-surface-raised p-6"
              data-skeleton-section="policy-summary"
            >
              <Pulse className="h-5 w-32" />
              {FIVE_ITEMS.map((row) => (
                <div
                  key={row}
                  className="flex items-center justify-between gap-4 border-t border-border-default pt-3"
                >
                  <Pulse className="h-4 w-24" />
                  <Pulse className="h-4 w-28" />
                </div>
              ))}
            </aside>
          </div>
        </div>
      </div>
      <footer
        className="shrink-0 border-t border-border-default bg-surface-raised px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
        data-wizard-actions
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <Pulse className="h-10 w-24 rounded-lg" />
          <Pulse className="h-10 w-28 rounded-lg" />
        </div>
      </footer>
    </LoadingRegion>
  );
}

function AuditHeaderSkeleton() {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-[1_1_34rem] space-y-2">
        <div className="space-y-1">
          <div data-loading-audit-title-line>
            <Pulse className="h-7 w-[94%] max-w-[34rem] sm:h-8 sm:w-72" />
          </div>
          <div className="sm:hidden" data-loading-audit-title-line>
            <Pulse className="h-7 w-[62%]" />
          </div>
        </div>
        <div className="space-y-1">
          <div data-loading-audit-description-line>
            <Pulse className="h-4 w-[94%] max-w-[34rem]" />
          </div>
          <div className="sm:hidden" data-loading-audit-description-line>
            <Pulse className="h-4 w-[72%]" />
          </div>
        </div>
      </div>
      <Pulse className="h-9 w-36 rounded-lg" />
    </div>
  );
}

export function WalletPolicyAuditListSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col">
      <LoadingRegion
        layout="wallet-policy-audit-list"
        className="flex w-full flex-1 flex-col gap-4"
      >
        <AuditHeaderSkeleton />
        <DashboardWorkspaceCard>
          <div
            className="grid gap-3 border-b border-border-default p-3 md:grid-cols-2 xl:grid-cols-5"
            data-loading-audit-filters
          >
            {FIVE_ITEMS.map((filter) => (
              <div key={filter} className="space-y-1.5">
                <Pulse className="h-3 w-20" />
                <Pulse className="h-10 w-full rounded-lg" />
              </div>
            ))}
          </div>
          <div className="flex-1 space-y-3 p-4" data-loading-audit-rows>
            {FIVE_ITEMS.map((row) => (
              <Pulse key={row} className="h-10 w-full rounded-lg" />
            ))}
          </div>
          <div
            className="mt-auto flex items-center justify-between border-t border-border-default p-4"
            data-loading-audit-footer
          >
            <Pulse className="h-10 w-44 rounded-lg" />
            <Pulse className="h-8 w-40 rounded-lg" />
          </div>
        </DashboardWorkspaceCard>
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function WalletPolicyAuditDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel>
      <LoadingRegion layout="wallet-policy-audit-detail" className="w-full space-y-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="w-full space-y-1 sm:w-auto">
              <div data-loading-detail-title-line>
                <Pulse className="h-7 w-80 max-w-full sm:h-8 sm:w-64" />
              </div>
              <div className="sm:hidden" data-loading-detail-title-line>
                <Pulse className="h-7 w-20" />
              </div>
            </div>
            <div data-loading-detail-decision-badge>
              <Pulse className="h-6 w-20 rounded-full" />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Pulse className="h-9 w-24 rounded-lg" />
              <Pulse className="h-9 w-20 rounded-lg" />
            </div>
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:gap-4">
            {FOUR_ITEMS.map((item) => (
              <div
                key={item}
                className="flex min-w-0 items-center gap-2"
                data-loading-detail-metadata
              >
                <Pulse className="size-4 shrink-0 rounded-sm" />
                <Pulse className={item === "four" ? "h-4 w-64 max-w-[80%]" : "h-4 w-32"} />
              </div>
            ))}
          </div>
        </section>
        <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_460px]">
          <main className="min-w-0">
            <div className="space-y-3">
              {FIVE_ITEMS.map((step) => (
                <div
                  key={step}
                  className="grid min-h-20 gap-3 rounded-lg border border-border-default bg-surface-raised p-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:items-start"
                  data-loading-audit-step
                >
                  <div className="flex items-center gap-2 sm:block" data-loading-step-icon>
                    <Pulse className="size-7 rounded-full" />
                    <Pulse className="mt-2 size-6 rounded-full" />
                  </div>
                  <div className="space-y-2">
                    <Pulse className="h-4 w-40" />
                    <Pulse className="h-4 w-full" />
                  </div>
                  <div className="sm:pt-0.5">
                    <Pulse className="h-6 w-16 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </main>
          <aside className="h-fit space-y-4 rounded-lg border border-border-default bg-surface-raised p-5">
            <Pulse className="h-5 w-36" />
            {FIVE_ITEMS.map((row) => (
              <div key={row} className="space-y-2 border-t border-border-default pt-3">
                <Pulse className="h-3 w-24" />
                <Pulse className="h-4 w-full" />
              </div>
            ))}
          </aside>
        </div>
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}
