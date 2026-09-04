import { COMPLIANCE_PROVIDERS, ORGANIZATION_RPC_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/dashboard/custody/provider-catalog";
import { INTEGRATION_FAMILIES, type IntegrationFamily } from "./integrations-filter";

/**
 * How many cards each family settles at, read from the same catalogues the page
 * maps over. A flat four per section left the placeholder 22% shorter than the
 * page it stood in for, because custody alone renders ten.
 *
 * `default` is only listed while the organization runs on it, so RPC is counted
 * one short of the union rather than assuming it shows.
 */
const FAMILY_CARD_COUNTS: Record<IntegrationFamily, number> = {
  custody: CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length,
  rpc: ORGANIZATION_RPC_PROVIDERS.length - 1,
  ramps: RAMP_PROVIDERS.length,
  compliance: COMPLIANCE_PROVIDERS.length,
  privacy: 1,
};

export function IntegrationsSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-6 px-4 py-5 md:px-6">
      {/* Matches the loaded toolbar: one segmented status control leading,
          the search slot on the right from xl up, stacked below. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="h-9 w-full max-w-[560px] rounded-full bg-fill-subtle" />
        <div className="h-10 w-full max-w-xs rounded-[10px] bg-fill-subtle xl:w-64 xl:shrink-0" />
      </div>
      {/* One block per family the catalog actually renders, read from the same
          constant it maps over: a fixed count here drifted to half the page. */}
      {INTEGRATION_FAMILIES.map((family) => (
        <div key={family} className="space-y-4">
          <div className="space-y-2">
            <div className="h-5 w-28 rounded bg-fill-subtle" />
            <div className="h-4 w-64 rounded bg-fill-subtle" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: FAMILY_CARD_COUNTS[family] }, (_, index) => index).map((card) => (
              <div
                key={card}
                className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised"
              />
            ))}
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
          compliance settle at 4 blocks, custody at 5, RPC at 6 once Connection
          and "Your own credentials" are counted. Five is the median, so no
          family jumps more than one block. Measured by the test beside this. */}
      <SkeletonSection headingWidth="w-32" />
      <SkeletonSection headingWidth="w-48" />
      <SkeletonSection headingWidth="w-24" />
      <SkeletonSection headingWidth="w-40" />
    </div>
  );
}
