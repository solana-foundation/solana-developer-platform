import { SkeletonBlock } from "@/components/ui/skeleton-block";

// Placeholders for the asset grid — the one home of the grid's loading geometry.
// The route-level IssuancePageSkeleton renders these same components, so the
// first paint and an in-place reload cannot drift apart.
//
// Shown when the tiles on screen have stopped answering the question being asked —
// a new search, filter or sort — and not for paging, where the previous page is a
// truthful neighbouring slice of the same list and stays put instead.
//
// Geometry mirrors the real card (same box, same padding, same avatar size, so
// the same height falls out) — swapping between placeholder and content must not
// move the page under the reader.

/** One grid tile: avatar + symbol/name with a status badge, then the meta rows. */
export function IssuanceTokenCardSkeleton() {
  return (
    <article
      className="flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5"
      data-loading-card="issuance-token"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <SkeletonBlock className="h-12 w-12 shrink-0 rounded-2xl" />
          <div className="min-w-0">
            <SkeletonBlock className="h-3 w-12" />
            <SkeletonBlock className="mt-2 h-7 w-36" />
          </div>
        </div>
        <SkeletonBlock className="h-6 w-16 shrink-0 self-start rounded-full" />
      </div>

      {/* Mint address, token ID, date — same three h-6 rows as the real card. */}
      <div className="mt-5 space-y-1.5">
        <div className="flex h-6 items-center justify-between gap-3">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-3 w-28" />
        </div>
        <div className="flex h-6 items-center justify-between gap-3">
          <SkeletonBlock className="h-3 w-14" />
          <SkeletonBlock className="h-3 w-32" />
        </div>
        <div className="flex h-6 items-center justify-between gap-3">
          <SkeletonBlock className="h-3 w-16" />
          <SkeletonBlock className="h-3 w-24" />
        </div>
      </div>
    </article>
  );
}

export function IssuanceAddTokenCardSkeleton() {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised">
      <SkeletonBlock className="size-6 rounded-md" />
      <SkeletonBlock className="h-4 w-28" />
    </div>
  );
}

export function IssuanceListSkeleton({ count }: { count: number }) {
  const items = Array.from({ length: Math.max(1, count) }, (_, index) => index);

  // The add-asset affordance is part of the real layout, so it gets a
  // placeholder too — without it the swap would come up one tile short.
  //
  // Decorative: the surrounding container carries `aria-busy`, and the live region
  // in the workspace is what actually announces the load.
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      aria-hidden="true"
      data-testid="issuance-grid-skeleton"
    >
      {items.map((index) => (
        <IssuanceTokenCardSkeleton key={index} />
      ))}
      <IssuanceAddTokenCardSkeleton />
    </div>
  );
}
