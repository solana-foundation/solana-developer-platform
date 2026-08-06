export function IntegrationsSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-8 px-4 py-6 md:px-6">
      <div className="mx-auto max-w-2xl space-y-2">
        <div className="mx-auto h-4 w-full rounded bg-fill-subtle" />
        <div className="mx-auto h-4 w-1/2 rounded bg-fill-subtle" />
      </div>
      <div className="space-y-3">
        <div className="h-11 w-full max-w-md rounded-2xl bg-fill-subtle" />
        {/* Two rows, matching the family and status pill rows the loaded
            catalog renders: five family pills, six status pills. */}
        <div className="flex flex-col gap-2">
          {[
            [48, 104, 84, 92, 116],
            [104, 96, 132, 84, 148, 120],
          ].map((row) => (
            <div key={row.join()} className="flex flex-wrap gap-2">
              {row.map((width) => (
                <div key={width} className="h-8 rounded-full bg-fill-subtle" style={{ width }} />
              ))}
            </div>
          ))}
        </div>
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
