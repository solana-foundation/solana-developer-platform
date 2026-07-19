import { SkeletonBlock } from "@/components/ui/skeleton-block";

const APPROVAL_FILTER_IDS = [
  "approval-filter-wallet",
  "approval-filter-operation",
  "approval-filter-api-key",
  "approval-filter-from",
  "approval-filter-to",
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

const APPROVAL_TABLE_COLUMN_IDS = [
  "approval-column-status",
  "approval-column-wallet",
  "approval-column-operation",
  "approval-column-amount",
  "approval-column-destination",
  "approval-column-requester",
  "approval-column-reason",
];

const APPROVAL_DETAIL_METADATA_IDS = [
  "approval-detail-metadata-wallet",
  "approval-detail-metadata-address",
  "approval-detail-metadata-requester",
  "approval-detail-metadata-api-key",
  "approval-detail-metadata-wallet-revision",
  "approval-detail-metadata-api-key-revision",
  "approval-detail-metadata-provider",
  "approval-detail-metadata-provider-status",
  "approval-detail-metadata-request-id",
  "approval-detail-metadata-submitted",
  "approval-detail-metadata-status",
];

export function ApprovalInboxSkeleton() {
  return (
    <div
      className="h-full overflow-y-auto px-3 pb-8 md:px-6"
      data-loading-layout="approvals-list"
      aria-busy="true"
    >
      <div className="mx-auto w-full max-w-[1500px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-64 max-w-full" />
            <SkeletonBlock className="h-4 w-96 max-w-full" />
          </div>
          <div className="flex items-center gap-3">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="size-8 rounded-[10px]" />
          </div>
        </header>

        <div className="mt-6 flex h-10 items-end gap-8 border-b border-border-default">
          <SkeletonBlock className="mb-3 h-4 w-20" />
          <SkeletonBlock className="mb-3 h-4 w-16" />
        </div>

        <div className="grid gap-3 border-b border-border-default py-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-[repeat(4,minmax(140px,1fr))_minmax(135px,0.75fr)_auto]">
          {APPROVAL_FILTER_IDS.map((id) => (
            <div key={id} className="space-y-1.5">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-10 w-full rounded-lg" />
            </div>
          ))}
          <div className="flex items-end">
            <SkeletonBlock className="h-9 w-24 rounded-[10px]" />
          </div>
        </div>

        <div
          className="divide-y divide-border-default border-b border-border-default 2xl:hidden"
          data-loading-mobile-rows
        >
          {APPROVAL_ROW_IDS.map((id) => (
            <article key={id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SkeletonBlock className="h-5 w-16 rounded-full" />
                  <SkeletonBlock className="h-3 w-20" />
                </div>
                <SkeletonBlock className="mt-3 h-4 w-32" />
                <SkeletonBlock className="mt-2 h-4 w-full max-w-md" />
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                  <SkeletonBlock className="h-7 w-full" />
                  <SkeletonBlock className="h-7 w-full" />
                </div>
              </div>
              <SkeletonBlock className="mt-1 size-8 rounded-[10px]" />
            </article>
          ))}
        </div>

        <div
          className="hidden overflow-hidden border-b border-border-default 2xl:block"
          data-loading-desktop-table
        >
          <div className="grid grid-cols-[88px_145px_145px_120px_120px_145px_minmax(160px,1fr)_115px_48px] gap-3 border-b border-border-default px-4 py-3">
            {APPROVAL_TABLE_COLUMN_IDS.map((id) => (
              <SkeletonBlock key={id} className="h-3 w-16" />
            ))}
            <SkeletonBlock className="h-3 w-16" />
            <SkeletonBlock className="h-3 w-6" />
          </div>
          <div className="divide-y divide-border-default">
            {APPROVAL_ROW_IDS.map((id) => (
              <div
                key={id}
                className="grid min-h-16 grid-cols-[88px_145px_145px_120px_120px_145px_minmax(160px,1fr)_115px_48px] items-center gap-3 px-4 py-3"
              >
                <SkeletonBlock className="h-5 w-16 rounded-full" />
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-4 w-20" />
                <SkeletonBlock className="h-4 w-20" />
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-4 w-20" />
                <SkeletonBlock className="size-8 rounded-[10px]" />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <SkeletonBlock className="h-3 w-36" />
          <div className="flex gap-2">
            <SkeletonBlock className="size-8 rounded-[10px]" />
            <SkeletonBlock className="h-8 w-20" />
            <SkeletonBlock className="size-8 rounded-[10px]" />
          </div>
        </div>
      </div>
    </div>
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
            <div className="flex items-center gap-3">
              <SkeletonBlock className="h-5 w-16 rounded-full" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
            <SkeletonBlock className="mt-4 h-8 w-full max-w-sm" />
            <SkeletonBlock className="mt-2 h-4 w-full max-w-2xl" />
          </div>
          <div className="flex flex-wrap gap-2">
            <SkeletonBlock className="h-10 w-20 rounded-[10px]" />
            <SkeletonBlock className="h-10 w-20 rounded-[10px]" />
            <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
          </div>
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
                <SkeletonBlock className="h-5 w-44" />
                <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <SkeletonBlock className="h-3 w-24" />
                    <SkeletonBlock className="h-4 w-40 max-w-full" />
                  </div>
                  <div className="space-y-2">
                    <SkeletonBlock className="h-3 w-20" />
                    <SkeletonBlock className="h-4 w-36 max-w-full" />
                  </div>
                </div>
              </section>
            ))}
          </main>

          <aside
            className="border-t border-border-default py-7 lg:border-t-0 lg:border-l lg:py-8 lg:pl-8"
            data-loading-metadata-rail
          >
            <div className="lg:sticky lg:top-6">
              <SkeletonBlock className="h-5 w-24" />
              <div className="mt-4 divide-y divide-border-default border-y border-border-default">
                {APPROVAL_DETAIL_METADATA_IDS.map((id) => (
                  <div key={id} className="flex items-center justify-between gap-4 py-3">
                    <SkeletonBlock className="h-3 w-24" />
                    <SkeletonBlock className="h-4 w-28" />
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
