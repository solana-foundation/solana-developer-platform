import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const APPROVAL_FILTER_IDS = [
  "approval-filter-wallet",
  "approval-filter-operation",
  "approval-filter-api-key",
  "approval-filter-date",
];

const APPROVAL_ROW_IDS = [
  "approval-row-1",
  "approval-row-2",
  "approval-row-3",
  "approval-row-4",
  "approval-row-5",
];

const APPROVAL_DETAIL_SECTION_IDS = [
  "approval-section-request",
  "approval-section-policy",
  "approval-section-operation",
  "approval-section-controls",
  "approval-section-timeline",
];

export function ApprovalInboxSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      className="flex flex-col"
      data-loading-layout="approvals-list"
      aria-busy="true"
    >
      <DashboardWorkspaceCard>
        <div className="flex flex-wrap items-end gap-3 border-b border-border-default p-3">
          {APPROVAL_FILTER_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-16 min-w-44 flex-1 rounded-lg" />
          ))}
        </div>

        <div className="flex-1">
          <div className="divide-y divide-border-default 2xl:hidden" data-loading-mobile-rows>
            {APPROVAL_ROW_IDS.map((id) => (
              <div key={id} className="p-4">
                <SkeletonBlock className="h-28 w-full" />
              </div>
            ))}
          </div>

          <div className="hidden overflow-hidden 2xl:block" data-loading-desktop-table>
            <div className="border-b border-border-default px-4 py-3">
              <SkeletonBlock className="h-3 w-64" />
            </div>
            <div className="divide-y divide-border-default">
              {APPROVAL_ROW_IDS.map((id) => (
                <div key={id} className="flex min-h-16 items-center px-4 py-3">
                  <SkeletonBlock className="h-6 w-full" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-default p-4">
          <SkeletonBlock className="h-8 w-44" />
          <SkeletonBlock className="h-8 w-36" />
        </div>
      </DashboardWorkspaceCard>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function ApprovalDetailSkeleton() {
  return (
    <div
      className="h-full overflow-y-auto px-3 pb-10 md:px-6"
      data-loading-layout="approval-detail"
      aria-busy="true"
    >
      <div className="mx-auto w-full max-w-[1500px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-5 border-b border-border-default pb-6">
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-8 w-full max-w-sm" />
            <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl" />
          </div>
          <SkeletonBlock className="h-10 w-64 rounded-[10px]" />
        </header>

        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0 lg:pr-8">
            {APPROVAL_DETAIL_SECTION_IDS.map((id, index) => (
              <section
                key={id}
                className={
                  index === APPROVAL_DETAIL_SECTION_IDS.length - 1
                    ? "py-8"
                    : "border-b border-border-default py-8"
                }
              >
                <SkeletonBlock className="h-20 w-full" />
              </section>
            ))}
          </main>

          <aside
            className="border-t border-border-default py-7 lg:border-t-0 lg:border-l lg:py-8 lg:pl-8"
            data-loading-metadata-rail
          >
            <div className="lg:sticky lg:top-6">
              <SkeletonBlock className="h-96 w-full" />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
