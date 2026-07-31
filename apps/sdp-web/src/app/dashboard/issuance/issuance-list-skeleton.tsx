import { SkeletonBlock } from "@/components/ui/skeleton-block";
import type { TokenView } from "./issuance-token-view";

// Placeholders for the asset list — the one home of the list's loading geometry.
// The route-level IssuancePageSkeleton renders these same components, so the
// first paint and an in-place reload cannot drift apart.
//
// Shown when the rows on screen have stopped answering the question being asked —
// a new search, filter or sort — and not for paging, where the previous page is a
// truthful neighbouring slice of the same list and stays put instead.
//
// Geometry mirrors the real row and card (same box, same padding, same avatar
// size, so the same height falls out) — swapping between placeholder and content
// must not move the page under the reader.

// Three applicable authorities is the usual draw (mint / freeze / metadata); a
// permanent delegate or a signer mark is the exception, not what the placeholder
// should reserve room for.
const TOKEN_CARD_AUTHORITY_MARK_IDS = [
  "token-card-authority-1",
  "token-card-authority-2",
  "token-card-authority-3",
];

function TokenCardStatSkeleton({
  labelWidth,
  valueWidth,
  className,
}: {
  labelWidth: string;
  valueWidth: string;
  /** Flex sizing from the row it sits in — Supply takes the slack, the date doesn't. */
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <div className="flex items-center gap-1">
        <SkeletonBlock className="size-3 shrink-0 rounded-[3px]" />
        <SkeletonBlock className={`h-3 ${labelWidth}`} />
      </div>
      <SkeletonBlock className={`mt-1 h-4 ${valueWidth}`} />
    </div>
  );
}

/** One grid tile: header, taxonomy chips, Control + Supply, then date + kebab. */
export function IssuanceTokenCardSkeleton() {
  return (
    <article
      className="flex min-h-[240px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5"
      data-loading-card="issuance-token"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SkeletonBlock className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0">
            <SkeletonBlock className="h-3 w-12" />
            <SkeletonBlock className="mt-1.5 h-5 w-32" />
          </div>
        </div>
        <SkeletonBlock className="h-6 w-16 shrink-0 rounded-full" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <SkeletonBlock className="h-5 w-28 rounded-full" />
        <SkeletonBlock className="h-5 w-20 rounded-full" />
      </div>

      {/* Control holds at least half the row and never shrinks, Supply takes the rest;
          the date keeps the bottom row with the kebab. */}
      <div className="mt-6 flex items-start gap-x-5">
        <div className="min-w-[50%] shrink-0">
          <div className="flex items-center gap-1">
            <SkeletonBlock className="size-3 shrink-0 rounded-[3px]" />
            <SkeletonBlock className="h-3 w-14" />
          </div>
          {/* Marks at their own size rather than a value bar, then the policy pills
              beside them — every stablecoin and security carries at least one. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {TOKEN_CARD_AUTHORITY_MARK_IDS.map((id) => (
              <SkeletonBlock key={id} className="size-6 shrink-0 rounded-[7px] lg:size-7" />
            ))}
            <SkeletonBlock className="h-4 w-20 rounded-full" />
          </div>
        </div>
        <TokenCardStatSkeleton labelWidth="w-12" valueWidth="w-8" className="flex-1" />
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-6">
        <TokenCardStatSkeleton labelWidth="w-16" valueWidth="w-20" />
        {/* ManageKebab's trigger footprint: a 32px icon button. */}
        <SkeletonBlock className="size-8 shrink-0 rounded-[10px]" />
      </div>
    </article>
  );
}

export function IssuanceAddTokenCardSkeleton() {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised">
      <SkeletonBlock className="size-6 rounded-md" />
      <SkeletonBlock className="h-4 w-28" />
    </div>
  );
}

// The row's centred stat cells (supply / decimals / date) — like CollapsedStat,
// they only appear from lg up.
function RowStatSkeleton({ labelWidth, valueWidth }: { labelWidth: string; valueWidth: string }) {
  return (
    <div className="hidden min-w-0 lg:block">
      <div className="flex items-center justify-center gap-1">
        <SkeletonBlock className="size-3 shrink-0 rounded-[3px]" />
        <SkeletonBlock className={`h-3 ${labelWidth}`} />
      </div>
      <div className="mt-1 flex justify-center">
        <SkeletonBlock className={`h-4 ${valueWidth}`} />
      </div>
    </div>
  );
}

// One collapsed row of the list view. The column tracks are copied verbatim from
// IssuanceTokenListRow — the whole point of a second skeleton is that the rows it
// draws land where the real ones will, so the tracks (and which of them drop out
// below lg/md) have to be the same, not merely similar.
export function IssuanceTokenRowSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
      data-loading-row="issuance-token"
    >
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 p-4 md:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto] lg:grid-cols-[auto_auto_11rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_auto]">
        {/* Chevron */}
        <SkeletonBlock className="size-7 shrink-0 rounded-lg" />
        <SkeletonBlock className="size-10 shrink-0 rounded-full" />
        <div className="min-w-0">
          <SkeletonBlock className="h-3 w-12" />
          <SkeletonBlock className="mt-1 h-4 w-28" />
        </div>
        {/* Chips stack — two, matching the grid tile's assumption. */}
        <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
          <SkeletonBlock className="h-5 w-28 rounded-full" />
          <SkeletonBlock className="h-5 w-20 rounded-full" />
        </div>
        <RowStatSkeleton labelWidth="w-12" valueWidth="w-16" />
        <RowStatSkeleton labelWidth="w-14" valueWidth="w-6" />
        <RowStatSkeleton labelWidth="w-16" valueWidth="w-20" />
        <div className="flex justify-end">
          <SkeletonBlock className="h-6 w-16 rounded-full" />
        </div>
        <div className="flex justify-end">
          {/* Same footprint the grid tile's kebab reserves — a 32px icon button. */}
          <SkeletonBlock className="size-8 shrink-0 rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}

export function IssuanceAddTokenRowSkeleton() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised py-3.5">
      <SkeletonBlock className="size-4 rounded-md" />
      <SkeletonBlock className="h-4 w-28" />
    </div>
  );
}

export function IssuanceListSkeleton({ view, count }: { view: TokenView; count: number }) {
  const items = Array.from({ length: Math.max(1, count) }, (_, index) => index);

  // The add-asset affordance is part of both real layouts, so it gets a
  // placeholder too — without it the swap would come up one tile short.
  //
  // Decorative: the surrounding container carries `aria-busy`, and the live region
  // in the workspace is what actually announces the load.
  return view === "list" ? (
    <div className="flex flex-col gap-2.5" aria-hidden="true" data-testid="issuance-list-skeleton">
      {items.map((index) => (
        <IssuanceTokenRowSkeleton key={index} />
      ))}
      <IssuanceAddTokenRowSkeleton />
    </div>
  ) : (
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
