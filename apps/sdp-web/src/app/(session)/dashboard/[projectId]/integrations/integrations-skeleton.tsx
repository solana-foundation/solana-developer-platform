import { cn } from "@sdp/ui/cn";
import type { DashboardFlags } from "@/flags/dashboard";
import { INTEGRATION_ROW_COLUMNS } from "./integration-sections";
import {
  familyRowsHaveChevron,
  type IntegrationsSkeletonSection,
  integrationsSkeletonSections,
  UNFLAGGED_SECTIONS,
} from "./integrations-skeleton-sections";

/**
 * The client loading path: the shell already holds the flag snapshot. Without one yet,
 * draws custody and RPC only rather than families the page may hide.
 */
export function IntegrationsFlagsSkeleton({ flags }: { flags?: DashboardFlags }) {
  return (
    <IntegrationsSkeleton
      sections={flags ? integrationsSkeletonSections(flags) : UNFLAGGED_SECTIONS}
    />
  );
}

export function IntegrationsSkeleton({
  sections,
}: {
  sections: readonly IntegrationsSkeletonSection[];
}) {
  return (
    <div className="w-full animate-pulse space-y-10">
      {sections.map((section) => {
        const hasChevron = familyRowsHaveChevron(section.family);
        return (
          <div key={section.family} className="space-y-2">
            <div className="flex h-6 items-center">
              <div className="h-5 w-28 rounded bg-fill-subtle" />
            </div>
            <ul className="divide-y divide-border-subtle">
              {Array.from({ length: section.rows }, (_, index) => index).map((row) => (
                <li key={row} className={cn(INTEGRATION_ROW_COLUMNS, "py-3")}>
                  <div className="size-10 rounded-full bg-fill-subtle" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="h-4 w-32 rounded bg-fill-subtle" />
                    <div className="h-3 w-56 max-w-full rounded bg-fill-subtle" />
                  </div>
                  <div className="hidden h-3 w-20 rounded bg-fill-subtle md:block" />
                  <div
                    className={cn(
                      "ml-auto h-3 w-24 rounded bg-fill-subtle",
                      !hasChevron && "col-span-2"
                    )}
                  />
                  {hasChevron ? <div /> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
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
