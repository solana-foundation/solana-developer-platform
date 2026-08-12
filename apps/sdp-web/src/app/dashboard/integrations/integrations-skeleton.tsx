export function IntegrationsSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-8 px-4 py-6 md:px-6">
      <div className="mx-auto max-w-2xl space-y-2">
        <div className="mx-auto h-4 w-full rounded bg-fill-subtle" />
        <div className="mx-auto h-4 w-1/2 rounded bg-fill-subtle" />
      </div>
      {/* One toolbar row, matching the loaded catalog: six status pills
          leading, the search field trailing at toolbar width. */}
      <div className="flex flex-wrap items-center gap-2">
        {[104, 96, 132, 84, 148, 120].map((width) => (
          <div key={width} className="h-8 rounded-full bg-fill-subtle" style={{ width }} />
        ))}
        <div className="h-10 w-full rounded-[10px] bg-fill-subtle sm:ms-auto sm:w-64" />
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="space-y-4">
          <div className="space-y-2">
            <div className="h-5 w-28 rounded bg-fill-subtle" />
            <div className="h-4 w-64 rounded bg-fill-subtle" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3].map((card) => (
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
    <div className="w-full animate-pulse space-y-6 px-4 py-6 md:px-6">
      <div className="h-[104px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
    </div>
  );
}
