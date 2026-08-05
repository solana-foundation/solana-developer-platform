export function IntegrationsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl animate-pulse space-y-8 px-4 py-6 md:px-6">
      <div className="space-y-2">
        <div className="h-4 w-2/3 rounded bg-fill-subtle" />
        <div className="h-4 w-1/3 rounded bg-fill-subtle" />
      </div>
      <div className="space-y-3">
        <div className="h-11 w-full max-w-md rounded-2xl bg-fill-subtle" />
        <div className="flex flex-wrap gap-2">
          {[56, 96, 72, 80, 104].map((width) => (
            <div key={width} className="h-8 rounded-full bg-fill-subtle" style={{ width }} />
          ))}
        </div>
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="space-y-4">
          <div className="space-y-2">
            <div className="h-5 w-28 rounded bg-fill-subtle" />
            <div className="h-4 w-64 rounded bg-fill-subtle" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1, 2, 3].map((card) => (
              <div
                key={card}
                className="h-[132px] rounded-2xl border border-border-subtle bg-surface-raised"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
