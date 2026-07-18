import { ChevronDown } from "lucide-react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { getTranslations } from "@/i18n/server";

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-[16px] bg-fill-strong ${className}`} />;
}

function WalletInfoCardSkeleton() {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="space-y-6 p-6">
        <div className="flex items-start gap-4">
          <SkeletonBlock className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2">
            <SkeletonBlock className="h-9 w-56" />
            <SkeletonBlock className="h-4 w-28" />
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
          {["public-key", "wallet-id", "status", "provider"].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
            >
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-4 w-44" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BalanceCardSkeleton() {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="space-y-6 p-6">
        <div>
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="mt-3 h-10 w-36" />
        </div>
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-fill-subtle">
          {["address", "provider", "purpose"].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
            >
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-4 w-32" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BalancesSectionSkeleton() {
  return (
    <section className="space-y-3">
      <SkeletonBlock className="h-10 w-36" />
      <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        {["balance-1", "balance-2"].map((row) => (
          <div
            key={row}
            className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
          >
            <div className="space-y-2">
              <SkeletonBlock className="h-5 w-20" />
              <SkeletonBlock className="h-3 w-56" />
            </div>
            <SkeletonBlock className="h-4 w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

async function ActivitySectionSkeleton() {
  const t = await getTranslations();
  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <SkeletonBlock className="h-7 w-40" />
          <SkeletonBlock className="h-4 w-72" />
        </div>
        <Button type="button" variant="secondary" size="sm" disabled>
          {t("DashboardCustody.refresh")}
        </Button>
      </div>
      <div className="mt-6 space-y-3">
        {["activity-1", "activity-2", "activity-3"].map((row) => (
          <SkeletonBlock key={row} className="h-9 w-full rounded-[10px]" />
        ))}
      </div>
    </section>
  );
}

export default async function WalletDetailLoading() {
  const t = await getTranslations();
  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled
          className="w-auto min-w-[132px] whitespace-nowrap"
          iconRight={<ChevronDown className="size-4" />}
        >
          {t("DashboardCustody.actions")}
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <WalletInfoCardSkeleton />
        <BalanceCardSkeleton />
      </div>

      <BalancesSectionSkeleton />
      <ActivitySectionSkeleton />
    </DashboardWorkspaceOverviewPanel>
  );
}
