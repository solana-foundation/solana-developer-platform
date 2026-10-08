import type { ReactNode } from "react";

/** The facts of one record as label and value pairs; fill it with {@link DetailRow}s. */
export function DetailList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={className}>{children}</dl>;
}

/** A label and its value on one 40px rule, as the design's record rows read: 13px, then 14px. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <dt className="shrink-0 text-meta leading-5 text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-body text-primary">{children}</dd>
    </div>
  );
}
