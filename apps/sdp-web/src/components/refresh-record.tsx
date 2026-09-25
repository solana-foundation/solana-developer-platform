import type { ReactNode } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { cn } from "@/lib/utils";

export type StateBandTone = "ok" | "warn" | "error" | "neutral";

const BAND_TONES: Record<StateBandTone, { band: string; word: string }> = {
  ok: { band: "border-success bg-success/7 dark:bg-success/12", word: "text-success" },
  warn: { band: "border-warning bg-warning/7 dark:bg-warning/12", word: "text-warning" },
  error: { band: "border-error bg-error/7 dark:bg-error/12", word: "text-error" },
  neutral: { band: "border-tertiary bg-surface-tile", word: "text-secondary" },
};

/**
 * A record's state as the design heads it: an 18px word in its tone over a 15px line saying
 * what it means, on a tinted band with a 2px rule at its start, and the one action it asks for
 * at the end.
 */
export function StateBand({
  tone,
  state,
  children,
  action,
}: {
  tone: StateBandTone;
  state: string;
  /** What the state means for the reader. */
  children?: ReactNode;
  action?: ReactNode;
}) {
  const colors = BAND_TONES[tone];
  return (
    <div
      data-state-band={tone}
      className={cn(
        "flex flex-col items-start gap-3 rounded-e-card border-s-2 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-6",
        colors.band
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:flex-1">
        <p className={cn("text-subheading font-medium", colors.word)}>{state}</p>
        {children ? <p className="max-w-[40em] text-nav text-secondary">{children}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A titled part of a record: an 18px heading (or a quiet 15px label, as over a balance) with
 * the part's one action at its right, 16px to the body. Parts sit 64px apart in `RecordStack`.
 */
export function RecordBlock({
  title,
  quiet = false,
  aside,
  children,
  className,
}: {
  title?: string;
  quiet?: boolean;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", className)}>
      {title ? (
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-4 [&>a]:-my-1 [&>a]:[--button-height-md:1.875rem] [&>button]:-my-1 [&>button]:[--button-height-md:1.875rem]">
          <h2
            className={
              quiet ? "text-nav text-secondary" : "text-subheading font-medium text-primary"
            }
          >
            {title}
          </h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The parts of a record, 64px apart on a desktop (32px on a phone), as the design spaces them. */
export function RecordStack({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-8 md:gap-16">{children}</div>;
}

/** Record rows in two columns 48px apart, one column on a phone. */
export function RecordColumns({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 gap-x-12 md:grid-cols-2">{children}</div>;
}

/**
 * A label and its value on one 40px rule, as the design's record rows read: 13px, then 14px.
 * A hint puts an (i) after the label.
 */
export function RecordRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <dt className="flex shrink-0 items-center gap-1.5 text-meta leading-5 text-secondary">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right text-body text-primary">
        {children}
      </dd>
    </div>
  );
}
