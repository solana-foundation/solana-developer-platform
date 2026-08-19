export function IntegrationsSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-6 px-4 py-5 md:px-6">
      {/* Matches the loaded toolbar: one segmented status control leading,
          the search slot on the right from xl up, stacked below. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="h-9 w-full max-w-[560px] rounded-full bg-fill-subtle" />
        <div className="h-10 w-full max-w-xs rounded-[10px] bg-fill-subtle xl:w-64 xl:shrink-0" />
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
    <div
      className="w-full animate-pulse space-y-6 px-4 py-6 md:px-6"
      data-loading-layout="integration-detail"
    >
      <div className="h-[104px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
      {/* RPC providers carry a Connection section above About. */}
      <div className="h-[120px] rounded-2xl border border-border-subtle bg-surface-raised" />
    </div>
  );
}
