import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export type StateBandTone = "ok" | "warn" | "error" | "info" | "neutral";

/**
 * A tone's tint, the ink of its word and glyph, and the glyph. A neutral state (expired,
 * canceled) reads in the primary ink on a plain tile.
 */
const BAND_TONES: Record<
  StateBandTone,
  { band: string; word: string; glyph: string; icon: LucideIcon }
> = {
  ok: {
    band: "bg-success/7 dark:bg-success/12",
    word: "text-success",
    glyph: "text-success",
    icon: CircleCheckIcon,
  },
  warn: {
    band: "bg-warning/7 dark:bg-warning/12",
    word: "text-warning",
    glyph: "text-warning",
    icon: TriangleAlertIcon,
  },
  error: {
    band: "bg-error/7 dark:bg-error/12",
    word: "text-error",
    glyph: "text-error",
    icon: CircleAlertIcon,
  },
  info: {
    band: "bg-info/7 dark:bg-info/12",
    word: "text-info",
    glyph: "text-info",
    icon: InfoIcon,
  },
  neutral: {
    band: "bg-surface-tile",
    word: "text-primary",
    glyph: "text-secondary",
    icon: InfoIcon,
  },
};

/**
 * A record's state as the design heads it: the tone's glyph, then the state in its ink over a
 * line saying what it means, both 14px, on a tile tinted by the tone, with the actions it asks
 * for at the end. Side by side from a 42rem container; stacked on a phone.
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
  const Icon = colors.icon;
  return (
    <div
      data-state-band={tone}
      className={cn(
        "flex flex-col items-start gap-3 rounded-card px-5 py-3 @2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-6",
        colors.band
      )}
    >
      <div className="flex w-full min-w-0 items-start gap-3 @2xl:flex-1">
        <span aria-hidden="true" className={cn("flex h-5 shrink-0 items-center", colors.glyph)}>
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className={cn("text-body font-medium", colors.word)}>{state}</p>
          {children ? <p className="max-w-[40em] text-body text-secondary">{children}</p> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * A titled part of a record: an 18px heading (or a quiet 13px label, as over a balance) with
 * the part's one action at its right, 16px to the body. A hint puts an (i) after the title.
 * Parts sit 64px apart in `RecordStack`.
 */
export function RecordBlock({
  title,
  hint,
  quiet = false,
  aside,
  children,
  className,
}: {
  title?: string;
  hint?: string;
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
            className={cn(
              hint && "flex items-center gap-1.5",
              quiet ? "text-meta text-secondary" : "text-subheading font-medium text-primary"
            )}
          >
            {title}
            {hint ? <InfoHint text={hint} /> : null}
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

/**
 * Record rows in two columns 48px apart, one column on a phone, where a column's last row keeps
 * its rule so the stacked columns read as one list.
 */
export function RecordColumns({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-x-12 max-md:[&>dl:not(:last-child)>div:last-child]:border-b md:grid-cols-2">
      {children}
    </div>
  );
}

/**
 * A label and its value on one 40px rule, as the design's record rows read: 13px, then 14px.
 * A hint puts an (i) after the label. On a phone the value sits under the label, 8px below it,
 * on a 68px rule.
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
    <div className="flex min-h-10 flex-col items-start gap-2 border-b border-border-subtle py-3 last:border-b-0 md:flex-row md:items-center md:justify-between md:gap-4 md:py-2.5">
      <dt className="flex shrink-0 items-center gap-1.5 text-meta leading-4 text-secondary md:leading-5">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd className="flex min-w-0 max-w-full items-center gap-1.5 text-body text-primary md:justify-end md:text-right">
        {children}
      </dd>
    </div>
  );
}

/**
 * A label in a 132px column and its value beside it, left-aligned, on one 44px rule: the
 * design's plan rows ("Pays", "Repeats", "Next run"), 13px then 14px. A hint puts an (i) after
 * the label.
 */
export function RecordLine({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <dt className="flex w-33 shrink-0 items-center gap-1.5 text-meta leading-5 text-secondary">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-body text-primary tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/**
 * Facts read label over value, without rules: 24px apart across and 20px down, two to a row on
 * a phone and `columns` from a 42rem container. A fact that matters less on a phone sets
 * `last` and moves to the end there.
 */
export function RecordFactGrid({
  columns = 3,
  children,
}: {
  columns?: 3 | 4;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        "grid min-w-0 grid-cols-2 gap-x-6 gap-y-5",
        columns === 4 ? "@2xl:grid-cols-4" : "@2xl:grid-cols-3"
      )}
    >
      {children}
    </dl>
  );
}

/**
 * Facts in two columns that keep their grouping, each a `dl` of facts 20px apart: one column on
 * a phone, side by side 24px apart from a 42rem container.
 */
export function RecordFactColumns({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-5 @2xl:grid-cols-2 [&>dl]:flex [&>dl]:min-w-0 [&>dl]:flex-col [&>dl]:gap-5">
      {children}
    </div>
  );
}

/**
 * One fact: a 13px label (an (i) after it when there is a hint) over its 14px value, which
 * keeps one line and carries its own copy or link controls.
 */
export function RecordFact({
  label,
  hint,
  last = false,
  children,
}: {
  label: string;
  hint?: string;
  /** Moves the fact to the end of the grid on a phone. */
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-record-fact
      className={cn("flex min-w-0 flex-col gap-0.5", last && "order-last @2xl:order-none")}
    >
      <dt className="flex items-center gap-1 text-meta text-tertiary">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-body text-primary">{children}</dd>
    </div>
  );
}
