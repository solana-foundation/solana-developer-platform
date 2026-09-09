"use client";

import { SkeletonBlock } from "@/components/ui/skeleton-block";

const SECTION_IDS = ["operations", "permissions", "settings", "activity"];
const ROW_IDS = ["first", "second"];

export function IssuanceDetailSkeleton() {
  return (
    <div
      className="space-y-5 px-1 pb-8 sm:space-y-6 sm:px-0"
      data-loading-layout="issuance-detail"
      aria-busy="true"
    >
      <header className="sm:py-2">
        <div className="flex justify-between gap-3 sm:flex-col sm:gap-4 lg:flex-row">
          <div className="flex min-w-0 items-start gap-4">
            <SkeletonBlock className="hidden size-11 shrink-0 rounded-full sm:block" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <SkeletonBlock className="h-7 w-40 max-w-full sm:h-8 sm:w-52" />
                <SkeletonBlock className="hidden h-5 w-16 rounded-md sm:block" />
              </div>
              <div data-loading-meta-line="issuance-detail">
                <SkeletonBlock className="h-5 w-28 sm:w-72" />
              </div>
              <div className="hidden items-center gap-1.5 sm:flex" data-loading-address-row>
                <SkeletonBlock className="h-3.5 w-24" />
                <SkeletonBlock className="size-5 rounded-md" />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SkeletonBlock className="hidden h-8 w-32 rounded-lg sm:block" />
            <SkeletonBlock className="h-8 w-24 rounded-lg" />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 sm:pl-[60px]" data-loading-header-stats>
          <SkeletonBlock className="h-4 w-36" />
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="hidden h-4 w-40 sm:block" />
        </div>
      </header>
      <div className="w-full divide-y divide-border-subtle">
        {SECTION_IDS.map((id, index) => (
          <section key={id} className="py-5" data-loading-section={id}>
            <div className="flex items-center justify-between">
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="size-4" />
            </div>
            {index < 2 ? (
              <div className="divide-y divide-border-subtle pt-4">
                {ROW_IDS.map((row) => (
                  <div key={row} className="flex items-center justify-between gap-4 py-5">
                    <div className="min-w-0 flex-1 space-y-2">
                      <SkeletonBlock className="h-4 w-40 max-w-full" />
                      <SkeletonBlock className="h-3 w-64 max-w-full" />
                    </div>
                    <SkeletonBlock className="h-9 w-24 shrink-0 rounded-lg" />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
