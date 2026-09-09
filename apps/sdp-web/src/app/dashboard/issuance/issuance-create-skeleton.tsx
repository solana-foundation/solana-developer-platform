"use client";

import { SkeletonBlock } from "@/components/ui/skeleton-block";

const ISSUANCE_CLASSIFICATION_CARD_IDS = [
  "issuance-classification-card-1",
  "issuance-classification-card-2",
];

export function IssuanceCreateSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-loading-layout="issuance-create"
      aria-busy="true"
    >
      <div className="shrink-0 px-[22px] pt-8 pb-6 min-[901px]:px-10">
        <div className="mx-auto w-full max-w-xl">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <SkeletonBlock className="h-1.5 w-5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
              <SkeletonBlock className="h-1.5 w-2.5 rounded-full" />
            </div>
            <SkeletonBlock className="h-3 w-[68px]" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] min-[901px]:px-10">
        <main className="mx-auto w-full max-w-xl space-y-[11px] pt-6 pb-10">
          {ISSUANCE_CLASSIFICATION_CARD_IDS.map((id) => (
            <div
              key={id}
              className="grid min-h-[104px] grid-cols-[42px_minmax(0,1fr)_20px] items-center gap-[15px] rounded-[14px] border border-border-default bg-surface-raised p-5"
              data-loading-card="issuance-classification"
            >
              <SkeletonBlock className="size-[42px] rounded-[11px]" />
              <div className="min-w-0">
                <SkeletonBlock className="h-5 w-48 max-w-full" />
                <SkeletonBlock className="mt-2 h-3.5 w-full max-w-[390px]" />
              </div>
              <SkeletonBlock className="size-[19px] rounded-full" />
            </div>
          ))}
        </main>
      </div>

      <div
        className="shrink-0 border-t border-border-default px-[22px] py-4 min-[901px]:px-10"
        data-loading-action-bar
      >
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
          <SkeletonBlock className="h-[38px] w-[78px] rounded-[9px]" />
          <SkeletonBlock className="h-[38px] w-[106px] rounded-[9px]" />
        </div>
      </div>
    </div>
  );
}
