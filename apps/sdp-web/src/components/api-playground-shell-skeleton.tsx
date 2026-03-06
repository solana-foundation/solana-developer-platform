function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-[12px] bg-[rgba(28,28,29,0.08)] ${className}`} />;
}

export function ApiPlaygroundShellSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="grid shrink-0 border-b border-[rgba(28,28,29,0.1)] lg:grid-cols-2">
        <div className="px-6 py-5">
          <SkeletonBlock className="h-11 w-full rounded-[14px]" />
        </div>
        <div className="border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <div className="flex justify-stretch lg:justify-end">
            <SkeletonBlock className="h-11 w-full max-w-[360px] rounded-[14px]" />
          </div>
        </div>
      </div>

      <div className="border-b border-[rgba(28,28,29,0.1)] px-6 py-4 lg:hidden">
        <SkeletonBlock className="h-11 w-full rounded-full" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-b border-[rgba(28,28,29,0.1)] lg:grid lg:grid-cols-2">
        <div className="min-h-0">
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            <div className="space-y-6">
              <div className="space-y-3">
                <SkeletonBlock className="h-6 w-36" />
                <div className="space-y-4">
                  <div className="space-y-2">
                    <SkeletonBlock className="h-4 w-20" />
                    <SkeletonBlock className="h-11 w-full" />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <SkeletonBlock className="h-6 w-32" />
                <div className="space-y-4">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div key={`playground-field-skeleton-${index + 1}`} className="space-y-2">
                      <SkeletonBlock className="h-4 w-28" />
                      <SkeletonBlock className="h-11 w-full" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 border-t border-[rgba(28,28,29,0.1)] lg:border-t-0">
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            <SkeletonBlock className="mb-4 h-11 w-full rounded-full" />
            <div className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-[8px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)]">
              <div className="flex-1 space-y-4 px-4 py-5">
                {Array.from({ length: 8 }, (_, index) => (
                  <SkeletonBlock
                    key={`playground-code-skeleton-${index + 1}`}
                    className={index % 2 === 0 ? "h-4 w-[92%]" : "h-4 w-[68%]"}
                  />
                ))}
              </div>
              <div className="border-t border-[rgba(28,28,29,0.1)] px-4 py-3">
                <SkeletonBlock className="h-6 w-28 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid shrink-0 lg:grid-cols-2">
        <div className="flex gap-3 px-6 py-5">
          <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-20 rounded-[10px]" />
        </div>
        <div className="flex gap-3 border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}
