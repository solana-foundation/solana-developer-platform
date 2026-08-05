export function IntegrationsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl animate-pulse space-y-10 px-4 py-6 md:px-6">
      <div className="h-4 w-2/3 rounded bg-fill-subtle" />
      {[0, 1, 2, 3].map((section) => (
        <div key={section} className="space-y-4">
          <div className="h-5 w-40 rounded bg-fill-subtle" />
          <div className="grid gap-3">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-[76px] rounded-2xl border border-border-subtle bg-surface-raised"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
