function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-[12px] bg-[rgba(28,28,29,0.08)] ${className}`} />;
}

function PaymentsSectionSkeleton() {
  return (
    <section className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white/80 p-5 shadow-[0_2px_10px_rgba(28,28,29,0.04)] animate-pulse">
      <div className="space-y-3">
        <SkeletonBlock className="h-6 w-36" />
        <SkeletonBlock className="h-4 w-[54%]" />
      </div>
      <div className="mt-6 space-y-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonBlock
            key={`payments-row-skeleton-${index + 1}`}
            className={index % 2 === 0 ? "h-11 w-full" : "h-11 w-[88%]"}
          />
        ))}
      </div>
    </section>
  );
}

export function PaymentsPageSkeleton() {
  return (
    <div className="grid gap-6">
      <PaymentsSectionSkeleton />
      <PaymentsSectionSkeleton />
    </div>
  );
}
