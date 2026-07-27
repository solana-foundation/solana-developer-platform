import { SkeletonBlock } from "@/components/ui/skeleton-block";

const RPC_CARD_SKELETON_IDS = [
  "rpc-card-alchemy",
  "rpc-card-helius",
  "rpc-card-nodit",
  "rpc-card-quicknode",
  "rpc-card-triton",
  "rpc-card-validation-cloud",
];

export function OrganizationOnboardingSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-loading-layout="organization-onboarding"
      aria-busy="true"
    >
      <div className="shrink-0 px-4 pt-7 pb-6 md:px-8">
        <div className="mx-auto w-full max-w-4xl">
          <SkeletonBlock className="h-5 w-36 rounded-md" />
          <SkeletonBlock className="mt-3 h-10 w-full max-w-sm rounded-lg" />
          <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl rounded-md" />
          <div className="mt-7 flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <SkeletonBlock className="h-1.5 w-5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
            </div>
            <SkeletonBlock className="h-3 w-16 rounded-md" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 md:px-8">
        <div className="mx-auto w-full max-w-4xl pb-10">
          <SkeletonBlock className="mb-6 h-8 w-72 max-w-full rounded-lg" />
          <div className="grid gap-4 md:grid-cols-2">
            {RPC_CARD_SKELETON_IDS.map((id) => (
              <div
                key={id}
                className="flex min-h-28 items-start gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-5"
                data-loading-provider-card
              >
                <SkeletonBlock className="size-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-3 pt-0.5">
                  <SkeletonBlock className="h-5 w-32 max-w-full rounded-md" />
                  <SkeletonBlock className="h-4 w-full max-w-xs rounded-md" />
                  <SkeletonBlock className="h-4 w-3/4 max-w-56 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-8">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-end">
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
        </div>
      </footer>
    </div>
  );
}
