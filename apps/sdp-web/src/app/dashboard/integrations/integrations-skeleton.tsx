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

export function IntegrationDetailSkeleton() {
  return (
    <div
      className="w-full animate-pulse space-y-6 px-4 py-6 md:px-6"
      data-loading-layout="integration-detail"
    >
      <div className="h-[104px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      {/* One shape stands in for every family, and they differ: ramps and
          compliance settle at 4 blocks, custody at 5, RPC at 6 once Connection
          and "Your own credentials" are counted. Five is the median, so no
          family jumps more than one block. Measured by the test beside this. */}
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
    </div>
  );
}
