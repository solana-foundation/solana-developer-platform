"use client";

import { createContext, type ReactNode, useContext } from "react";
import { cn } from "./cn";

/**
 * How the rows read. A `record` lists a saved thing's facts on 40px subtle rules, its labels at
 * 13px. A `summary` recaps a payment before it is sent: taller rows on the default divider, with
 * the label and value both at 14px.
 */
export type DetailListVariant = "record" | "summary";

const LIST_CLASS: Record<DetailListVariant, string | undefined> = {
  record: undefined,
  summary: "divide-y divide-border-default",
};

const DetailListVariantContext = createContext<DetailListVariant>("record");

/** The facts of one record as label and value pairs; fill it with {@link DetailRow}s. */
export function DetailList({
  children,
  className,
  variant = "record",
}: {
  children: ReactNode;
  className?: string;
  variant?: DetailListVariant;
}) {
  return (
    <DetailListVariantContext.Provider value={variant}>
      <dl className={cn(LIST_CLASS[variant], className) || undefined}>{children}</dl>
    </DetailListVariantContext.Provider>
  );
}

/**
 * How a value that runs long gives way. `truncate` ends it in an ellipsis, for facts the row only
 * names. `wrap` wraps it while the label keeps its width, for a name the reader confirms before
 * sending. `figure` never breaks it, so the label wraps beside it instead: an amount reads whole
 * and on one line, since a digit pushed onto the next line misreads as another figure.
 */
export type DetailRowFit = "truncate" | "wrap" | "figure";

const FIT_CLASS = {
  truncate: { summaryLabel: undefined, recordLabel: "shrink-0", value: "min-w-0 truncate" },
  wrap: {
    summaryLabel: "shrink-0",
    recordLabel: "shrink-0",
    value: "min-w-0 break-words text-pretty",
  },
  figure: { summaryLabel: "min-w-0", recordLabel: "min-w-0", value: "shrink-0 whitespace-nowrap" },
} as const satisfies Record<
  DetailRowFit,
  { summaryLabel: string | undefined; recordLabel: string; value: string }
>;

/**
 * A label and its value on one rule. A record row is 40px: 13px, then 14px. A summary row may
 * carry an icon, shown in a round tile beside the label outside the refresh scope only. `fit`
 * says how a long value gives way.
 */
export function DetailRow({
  label,
  icon,
  fit = "truncate",
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  fit?: DetailRowFit;
  children: ReactNode;
}) {
  const variant = useContext(DetailListVariantContext);
  const fitClass = FIT_CLASS[fit];
  if (variant === "summary") {
    return (
      <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0 refresh:py-3.5 refresh:first:pt-3.5">
        <dt
          className={cn(
            "flex items-center gap-2.5 text-sm text-tertiary refresh:text-body refresh:text-secondary",
            fitClass.summaryLabel
          )}
        >
          {icon === undefined ? null : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-secondary refresh:hidden">
              {icon}
            </span>
          )}
          {label}
        </dt>
        <dd
          className={cn(
            fitClass.value,
            "text-right text-sm font-medium text-primary refresh:text-body refresh:font-normal"
          )}
        >
          {children}
        </dd>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <dt className={cn(fitClass.recordLabel, "text-meta leading-5 text-secondary")}>{label}</dt>
      <dd className={cn(fitClass.value, "text-right text-body text-primary")}>{children}</dd>
    </div>
  );
}
