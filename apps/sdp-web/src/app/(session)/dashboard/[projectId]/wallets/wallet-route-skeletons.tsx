import { cn } from "@sdp/ui/cn";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { DashboardHeaderTabsTrailing } from "@/components/dashboard-header-tabs";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";

const TWO_ITEMS = ["one", "two"] as const;
const THREE_ITEMS = ["one", "two", "three"] as const;
const FOUR_ITEMS = ["one", "two", "three", "four"] as const;
const CARD_FIELDS = ["address", "wallet-id"] as const;
const RECORD_COLUMNS = ["left", "right"] as const;

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

/** A wallet card: mark and name, the balance, then the address and wallet ID under a rule. */
function WalletCardSkeleton() {
  return (
    <article className="flex flex-col rounded-card bg-surface-tile">
      <div className="flex items-center gap-3 px-4 pt-4">
        <Pulse className="size-8 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Pulse className="h-4 w-40 max-w-full" />
          <Pulse className="h-3.5 w-28" />
        </div>
      </div>
      <div className="px-4 pt-6 pb-7">
        <Pulse className="h-6 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 border-t border-border-subtle px-4 py-3">
        {CARD_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <Pulse className="h-3 w-14" />
            <Pulse className="h-3.5 w-28" />
          </div>
        ))}
      </div>
    </article>
  );
}

/**
 * The Wallets list's toolbar row in the header's tab row, held while the list loads and in the
 * states that draw no toolbar (no wallets, a failed read). On a phone, where the tabs are
 * hidden, the row is the toolbar's alone, so a row that came and went would move the page.
 *
 * @param props.loading - A pulse while the list loads; after, an empty hold of the same height.
 * @returns The hold, portalled into the header's tab row.
 */
export function WalletsToolbarRowHold({ loading }: { loading: boolean }) {
  return (
    <DashboardHeaderTabsTrailing>
      {loading ? (
        <SkeletonBlock className="h-7 w-24" />
      ) : (
        <span aria-hidden="true" className="block h-7" />
      )}
    </DashboardHeaderTabsTrailing>
  );
}

export function WalletsOverviewSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <WalletsToolbarRowHold loading />
      <LoadingRegion layout="wallets-overview">
        <div className="grid gap-5 sm:grid-cols-2" data-wallet-grid-skeleton>
          {FOUR_ITEMS.map((item) => (
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

/**
 * The create flow in its one-screen geometry, as a project's first wallet draws it: the title,
 * the custody question with its two answers, the label, the summary rows, and the footer band.
 */
export function WalletSetupSkeleton() {
  return (
    <LoadingRegion layout="wallet-setup" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-9 md:px-6">
        <div className="mx-auto w-full max-w-flow">
          <Pulse className="mb-6 h-8 w-44" />
          <div className="space-y-8">
            <div>
              <Pulse className="h-5 w-64 max-w-full" />
              <div className="mt-3 overflow-hidden rounded-card border border-border-default bg-surface-tile">
                {TWO_ITEMS.map((answer) => (
                  <div
                    key={answer}
                    className="flex items-center gap-3 border-t border-border-subtle px-4 py-3 first:border-t-0"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Pulse className="h-4 w-40" />
                      <Pulse className="h-3.5 w-64 max-w-full" />
                    </div>
                    <Pulse className="size-4 shrink-0 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Pulse className="h-4 w-24" />
              <Pulse className="h-9 w-full rounded-control" />
            </div>
            <div>
              <Pulse className="h-5 w-24" />
              <div className="mt-2">
                {FOUR_ITEMS.map((row) => (
                  <div
                    key={row}
                    className="flex h-12 items-center justify-between gap-4 border-b border-border-subtle last:border-b-0"
                  >
                    <Pulse className="h-4 w-20" />
                    <Pulse className="h-4 w-32" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-border-subtle bg-surface px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-flow flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <Pulse className="h-4 w-56 max-w-full" />
          <div className="flex items-center justify-end gap-4 sm:ml-auto">
            <Pulse className="h-10 w-20 rounded-control" />
            <Pulse className="h-10 w-28 rounded-control" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

/** Record rows as the wallet page draws them: 40px rules, a short label and a longer value. */
function RecordRowsSkeleton() {
  return (
    <div className="grid gap-x-12 md:grid-cols-2">
      {RECORD_COLUMNS.map((column) => (
        <div key={column}>
          {THREE_ITEMS.map((row) => (
            <div
              key={row}
              className="flex min-h-10 items-center justify-between gap-4 border-b border-border-subtle last:border-b-0"
            >
              <Pulse className="h-3 w-16" />
              <Pulse className="h-3.5 w-28" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RecordTableSkeleton({ section }: { section: string }) {
  return (
    <section className="flex flex-col gap-4" data-skeleton-section={section}>
      <Pulse className="h-5 w-32" />
      <div>
        {THREE_ITEMS.map((row) => (
          <div
            key={row}
            className="flex min-h-11 items-center justify-between gap-4 border-b border-border-subtle last:border-b-0"
          >
            <Pulse className="h-3.5 w-28" />
            <Pulse className="h-3.5 w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A wallet's page while it loads, in its Overview's geometry: the state band, the balance over
 * its record rows, then the Tokens and Recent activity tables, 64px apart.
 */
export function WalletDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel>
      <LoadingRegion layout="wallet-detail" className="flex flex-col gap-8 md:gap-16">
        <div data-skeleton-section="wallet-state">
          <Pulse className="h-16 w-full rounded-e-card" />
        </div>
        <section className="flex flex-col gap-4" data-skeleton-section="wallet-balance">
          <Pulse className="h-4 w-16" />
          <Pulse className="h-11 w-48" />
          <div className="mt-4">
            <RecordRowsSkeleton />
          </div>
        </section>
        <RecordTableSkeleton section="wallet-tokens" />
        <RecordTableSkeleton section="wallet-activity" />
      </LoadingRegion>
    </DashboardWorkspaceOverviewPanel>
  );
}
