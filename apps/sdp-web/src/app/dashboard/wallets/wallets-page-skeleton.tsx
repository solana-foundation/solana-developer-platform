import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-[16px] bg-[rgba(28,28,29,0.1)] ${className}`} />;
}

const PROVIDER_SKELETON_IDS = [
  "provider-skeleton-1",
  "provider-skeleton-2",
  "provider-skeleton-3",
  "provider-skeleton-4",
  "provider-skeleton-5",
  "provider-skeleton-6",
];
const WALLET_CARD_SKELETON_IDS = [
  "wallet-card-skeleton-1",
  "wallet-card-skeleton-2",
  "wallet-card-skeleton-3",
  "wallet-card-skeleton-4",
  "wallet-card-skeleton-5",
];

function WalletCardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[#fcfcfa] p-5">
      <SkeletonBlock className="h-12 w-12 rounded-2xl" />
      <div className="mt-4 space-y-2">
        <SkeletonBlock className="h-4 w-24" />
        <SkeletonBlock className="h-8 w-40" />
      </div>
      <div className="mt-6 space-y-3 rounded-xl border border-[rgba(28,28,29,0.06)] bg-white/70 p-3">
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-full" />
      </div>
      <SkeletonBlock className="mt-3 h-11 w-full rounded-[10px]" />
    </div>
  );
}

function ProviderCardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[#fcfcfa] p-5">
      <div className="flex items-start justify-between gap-4">
        <SkeletonBlock className="h-12 w-12 rounded-2xl" />
        <SkeletonBlock className="h-6 w-24 rounded-full" />
      </div>
      <div className="mt-5 space-y-2">
        <SkeletonBlock className="h-7 w-32" />
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-4/5" />
      </div>
      <div className="mt-4 flex gap-2">
        <SkeletonBlock className="h-6 w-20 rounded-full" />
        <SkeletonBlock className="h-6 w-24 rounded-full" />
      </div>
      <SkeletonBlock className="mt-8 h-9 w-full rounded-[10px]" />
    </div>
  );
}

export function WalletsOnboardingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SkeletonBlock className="h-7 w-64" />
        <SkeletonBlock className="h-4 w-[52%]" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {PROVIDER_SKELETON_IDS.map((id) => (
          <ProviderCardSkeleton key={id} />
        ))}
      </div>
    </div>
  );
}

export function WalletsPageSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel className="space-y-6">
      <div className="flex justify-end">
        <Button type="button" disabled className="w-full lg:w-auto">
          Create Wallet
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {WALLET_CARD_SKELETON_IDS.map((id) => (
          <WalletCardSkeleton key={id} />
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
