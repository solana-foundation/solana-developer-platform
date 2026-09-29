import { SkeletonBlock } from "@/components/ui/skeleton-block";

const SKELETON_ROWS = ["one", "two", "three"] as const;
const SKELETON_COLUMNS = [
  "status",
  "asset",
  "direction",
  "counterparty",
  "signature",
  "created",
] as const;
export const WALLET_ACTIVITY_HEADING_ID = "wallet-activity-heading";

interface WalletActivitySkeletonProps {
  description?: string;
  headingId?: string;
  title?: string;
}

export function WalletActivitySkeleton({
  description,
  headingId,
  title,
}: WalletActivitySkeletonProps = {}) {
  return (
    <div
      aria-busy="true"
      className="min-h-[22rem] min-w-0 overflow-hidden rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 text-primary shadow-sm ring-1 ring-border-default"
      data-skeleton-section="wallet-activity"
    >
      <div className="flex min-w-0 flex-col gap-3 px-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          {title ? (
            <h3 id={headingId} className="text-[19px] leading-6 font-medium text-primary">
              {title}
            </h3>
          ) : (
            <SkeletonBlock className="h-6 w-40" />
          )}
          {description ? (
            <p className="text-sm text-secondary">{description}</p>
          ) : (
            <SkeletonBlock className="h-4 w-72 max-w-full" />
          )}
        </div>
        <SkeletonBlock className="h-9 w-24 shrink-0 rounded-lg" />
      </div>

      <div className="mt-6 px-6">
        <div className="overflow-hidden rounded-xl border border-border-subtle">
          <div className="hidden grid-cols-[9rem_1fr_8rem_1fr_1fr_10rem] gap-4 bg-fill-subtle px-4 py-3 md:grid">
            {SKELETON_COLUMNS.map((column) => (
              <SkeletonBlock key={column} className="h-3 w-full max-w-20" />
            ))}
          </div>
          {SKELETON_ROWS.map((row) => (
            <div
              key={row}
              className="grid min-h-14 grid-cols-[7rem_minmax(0,1fr)] items-center gap-4 border-t border-border-subtle px-4 py-3 first:border-t-0 md:grid-cols-[9rem_minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1fr)_10rem]"
            >
              <SkeletonBlock className="h-6 w-20 rounded-full" />
              <SkeletonBlock className="h-4 w-full max-w-28" />
              <SkeletonBlock className="hidden h-4 w-16 md:block" />
              <SkeletonBlock className="hidden h-4 w-full max-w-32 md:block" />
              <SkeletonBlock className="hidden h-4 w-full max-w-28 md:block" />
              <SkeletonBlock className="hidden h-4 w-20 md:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
