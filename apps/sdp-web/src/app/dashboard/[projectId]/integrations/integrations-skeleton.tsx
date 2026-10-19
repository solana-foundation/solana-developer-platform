import { COMPLIANCE_PROVIDERS } from "@sdp/types/provider-access";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import type { DashboardFlags } from "@/flags/dashboard";
import {
  type IntegrationsSkeletonLayout,
  integrationsSkeletonLayout,
} from "./integration-feature-gates";
import type { IntegrationFamily } from "./integrations-filter";

/**
 * How many cards each family settles at, read from the same catalogues the page
 * maps over. A flat four per section left the placeholder 22% shorter than the
 * page it stood in for, because custody alone renders ten.
 */
function familyCardCount(family: IntegrationFamily, layout: IntegrationsSkeletonLayout): number {
  switch (family) {
    case "custody":
      return CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length;
    case "ramps":
      return layout.rampCards;
    case "compliance":
      return COMPLIANCE_PROVIDERS.length;
    case "privacy":
      return 1;
    default: {
      const unhandledFamily: never = family;
      throw new Error(`Unhandled integration family: ${unhandledFamily}`);
    }
  }
}

/** Custody runs in every release channel, so it is the one family safe to draw unflagged. */
const CUSTODY_ONLY_LAYOUT: IntegrationsSkeletonLayout = { families: ["custody"], rampCards: 0 };

/**
 * The client loading path: the shell already holds the flag snapshot. Without one yet,
 * draws custody only rather than families the page may hide.
 */
export function IntegrationsFlagsSkeleton({ flags }: { flags?: DashboardFlags }) {
  return (
    <IntegrationsSkeleton
      layout={flags ? integrationsSkeletonLayout(flags) : CUSTODY_ONLY_LAYOUT}
    />
  );
}

export function IntegrationsSkeleton({ layout }: { layout: IntegrationsSkeletonLayout }) {
  return (
    <div className="w-full animate-pulse space-y-6 px-4 py-5 md:px-6">
      {/* Matches the loaded toolbar: one segmented status control leading,
          the search slot on the right from xl up, stacked below. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="h-9 w-full max-w-[560px] rounded-full bg-fill-subtle" />
        <div className="h-10 w-full max-w-xs rounded-[10px] bg-fill-subtle xl:w-64 xl:shrink-0" />
      </div>
      {/* One block per family the catalog renders for these flags: drawing every
          family showed sections the release channel hides, which then vanished. */}
      {layout.families.map((family) => (
        <div key={family} className="space-y-4">
          <div className="space-y-2">
            <div className="h-5 w-28 rounded bg-fill-subtle" />
            <div className="h-4 w-64 rounded bg-fill-subtle" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: familyCardCount(family, layout) }, (_, index) => index).map(
              (card) => (
                <div
                  key={card}
                  className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised"
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One loaded `Section`: a heading with a couple of lines under it.
 *
 * The outer height stays fixed so the placeholder reserves exactly what it did
 * before; only the inside gained shape. Flat bars stood in for sections that
 * all carry a heading, which made the skeleton read as a different page rather
 * than a dimmer one.
 */
function SkeletonSection({ headingWidth = "w-40" }: { headingWidth?: string }) {
  // Exactly two lines: p-6 (48) + heading (20) + mt-3 (12) + two 16px lines and
  // an 8px gap fills the 120px box to the pixel. A third line overflowed the
  // rounded border, which is only visible on the render, never in the markup.
  return (
    <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised p-6">
      <div className={`h-5 rounded bg-fill-subtle ${headingWidth}`} />
      <div className="mt-3 space-y-2">
        <div className="h-4 w-2/3 rounded bg-fill-subtle" />
        <div className="h-4 w-1/3 rounded bg-fill-subtle" />
      </div>
    </div>
  );
}

export function IntegrationDetailSkeleton() {
  return (
    <div
      className="w-full animate-pulse space-y-6 px-4 py-6 md:px-6"
      data-loading-layout="integration-detail"
    >
      {/* The header is the one block that is not a section: a provider mark,
          the name with its status beside it, and the primary action opposite.

          Wraps and grows exactly as the loaded header does (`flex flex-wrap`,
          no fixed height). A fixed 104px row could not wrap, so on a narrow
          viewport the placeholders overflowed it and then the real header --
          which does wrap -- landed taller, jumping the page it was supposed to
          be holding still. `min-h` keeps the desktop height it reserves. */}
      <div className="flex min-h-[104px] flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-subtle bg-surface-raised p-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="h-12 w-12 shrink-0 rounded-full bg-fill-subtle" />
          <div className="min-w-0 space-y-2">
            <div className="h-5 w-44 max-w-full rounded bg-fill-subtle" />
            <div className="h-4 w-28 max-w-full rounded bg-fill-subtle" />
          </div>
        </div>
        <div className="h-9 w-32 shrink-0 rounded-[10px] bg-fill-subtle" />
      </div>
      {/* One shape stands in for every family, and they differ: ramps and
          compliance settle at 4 blocks, custody at 5. Five matches custody, so
          no family jumps more than one block. Measured by the test beside
          this. */}
      <SkeletonSection headingWidth="w-32" />
      <SkeletonSection headingWidth="w-48" />
      <SkeletonSection headingWidth="w-24" />
      <SkeletonSection headingWidth="w-40" />
    </div>
  );
}
