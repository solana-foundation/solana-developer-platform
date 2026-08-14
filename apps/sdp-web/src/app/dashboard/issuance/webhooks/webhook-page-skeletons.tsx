import { SkeletonBlock } from "@/components/ui/skeleton-block";

const ENDPOINT_ROW_IDS = [
  "webhook-endpoint-row-1",
  "webhook-endpoint-row-2",
  "webhook-endpoint-row-3",
  "webhook-endpoint-row-4",
];

const DELIVERY_ROW_IDS = [
  "webhook-delivery-row-1",
  "webhook-delivery-row-2",
  "webhook-delivery-row-3",
  "webhook-delivery-row-4",
  "webhook-delivery-row-5",
];

const DETAIL_FIELD_IDS = [
  "webhook-detail-field-url",
  "webhook-detail-field-id",
  "webhook-detail-field-created",
  "webhook-detail-field-secret",
];

export function WebhookEndpointsListSkeleton() {
  return (
    <div
      className="h-full overflow-y-auto px-3 pb-8 md:px-6"
      data-loading-layout="webhooks-list"
      aria-busy="true"
    >
      <div className="mx-auto w-full max-w-[1200px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-48 max-w-full" />
            <SkeletonBlock className="h-4 w-80 max-w-full" />
          </div>
          <SkeletonBlock className="h-9 w-36 rounded-full" />
        </header>
        <div className="mt-6 overflow-hidden rounded-xl border border-border-default">
          <SkeletonBlock className="h-10 w-full rounded-none" />
          <div className="divide-y divide-border-default">
            {ENDPOINT_ROW_IDS.map((id) => (
              <div key={id} className="flex items-center gap-4 px-4 py-4">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-72 max-w-full flex-1" />
                <SkeletonBlock className="h-5 w-16 rounded-sm" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebhookEndpointDetailSkeleton() {
  return (
    <div
      className="h-full overflow-y-auto px-3 pb-8 md:px-6"
      data-loading-layout="webhook-detail"
      aria-busy="true"
    >
      <div className="mx-auto w-full max-w-[1200px] py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBlock className="h-8 w-56 max-w-full" />
            <SkeletonBlock className="h-4 w-40" />
          </div>
          <div className="flex items-center gap-2">
            <SkeletonBlock className="h-9 w-28 rounded-full" />
            <SkeletonBlock className="h-9 w-28 rounded-full" />
          </div>
        </header>
        <div className="mt-6 rounded-xl border border-border-default p-5">
          <div className="grid gap-4 md:grid-cols-2">
            {DETAIL_FIELD_IDS.map((id) => (
              <div key={id} className="space-y-2">
                <SkeletonBlock className="h-3 w-24" />
                <SkeletonBlock className="h-4 w-64 max-w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 space-y-2">
          <SkeletonBlock className="h-6 w-32" />
          <div className="overflow-hidden rounded-xl border border-border-default">
            <SkeletonBlock className="h-10 w-full rounded-none" />
            <div className="divide-y divide-border-default">
              {DELIVERY_ROW_IDS.map((id) => (
                <div key={id} className="flex items-center gap-4 px-4 py-3">
                  <SkeletonBlock className="h-5 w-20 rounded-sm" />
                  <SkeletonBlock className="h-4 w-32" />
                  <SkeletonBlock className="h-4 w-16" />
                  <SkeletonBlock className="h-4 w-24" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
