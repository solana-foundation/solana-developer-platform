import { COMPLIANCE_PROVIDERS } from "@sdp/types/provider-access";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
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

const DETAIL_ROW_KEYS = ["family", "kind", "used-for", "signing", "wallets", "set-up"];

export function IntegrationDetailSkeleton() {
  // The header names the provider from the static catalog, so only the body waits: the state
  // band, then the details rows on their 44px rules (the connections list, custody only, sits
  // between them once it loads).
  return (
    <div className="w-full animate-pulse" data-loading-layout="integration-detail">
      <div className="flex min-w-0 flex-col gap-12 pt-6 md:gap-20 md:pt-10">
        <div className="h-16 rounded-card bg-fill-subtle" />
        <div className="flex flex-col gap-4">
          <div className="h-6 w-24 rounded bg-fill-subtle" />
          <div>
            {DETAIL_ROW_KEYS.map((key) => (
              <div
                key={key}
                className="flex h-11 items-center gap-3 border-b border-border-subtle last:border-b-0"
              >
                <div className="h-4 w-24 shrink-0 rounded bg-fill-subtle" />
                <div className="ml-9 h-4 w-40 rounded bg-fill-subtle" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
