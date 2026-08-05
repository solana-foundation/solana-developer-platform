"use client";

import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for the Earn deposit flow. Quiet SDP grammar throughout:
 * white raised surfaces, 1px subtle borders, restrained motion, and selection
 * expressed by a border plus a single check mark rather than colour or shadow.
 */

/** Stable keys for placeholder rows; shared so each surface does not re-declare them. */
export const SKELETON_ROW_IDS = ["one", "two", "three"];

/** Selection affordance shared by every choosable row and card in the flow. */
export function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected
          ? "border-primary bg-primary text-on-primary"
          : "border-border-strong bg-surface-raised text-transparent"
      )}
    >
      <CheckIcon className="size-3" />
    </span>
  );
}

/**
 * A radio-backed selectable card. The native input stays in the DOM for
 * keyboard and screen-reader behaviour; the label carries the visuals.
 */
export function SelectableCard({
  children,
  describedBy,
  inputId,
  labelledBy,
  name,
  onSelect,
  selected,
  value,
}: {
  children: ReactNode;
  describedBy?: string;
  inputId: string;
  labelledBy: string;
  name: string;
  onSelect: () => void;
  selected: boolean;
  value: string;
}) {
  return (
    // `relative` is load-bearing: the sr-only radio inside is absolutely
    // positioned, and without a positioned ancestor it lands near the top of
    // the page — so selecting a card low in a scrolled list yanked the view to
    // the top when the browser scrolled the newly-focused input into view.
    <div
      className={cn(
        "relative h-full rounded-2xl border bg-surface-raised transition-[border-color,background-color] duration-200 ease-out motion-reduce:transition-none",
        selected
          ? "border-primary bg-fill-subtle"
          : "border-border-default hover:border-border-strong hover:bg-fill-subtle/60"
      )}
    >
      <input
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        checked={selected}
        className="peer sr-only"
        id={inputId}
        name={name}
        onChange={onSelect}
        type="radio"
        value={value}
      />
      <label
        className="block h-full cursor-pointer rounded-2xl p-4 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 sm:p-5"
        htmlFor={inputId}
      >
        {children}
      </label>
    </div>
  );
}

/** A quiet framed note: an icon, a title, and one line of explanation. */
export function StepNote({
  body,
  icon,
  title,
}: {
  body: ReactNode;
  icon: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
      <span className="mt-0.5 shrink-0 text-secondary">{icon}</span>
      <div className="min-w-0">
        {title ? <p className="text-sm font-medium text-primary">{title}</p> : null}
        <p className={cn("text-[13px] leading-5 text-secondary", title && "mt-1")}>{body}</p>
      </div>
    </div>
  );
}

/** One label/value line. The label wraps first so short values stay intact. */
export function SummaryRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 text-sm last:border-b-0">
      <span className="min-w-0 text-secondary">{label}</span>
      <span className="shrink-0 text-right whitespace-nowrap text-primary">{value}</span>
    </div>
  );
}

/** A card-framed section with a tinted header strip. */
export function StepSection({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {action}
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

/** Uniform loading placeholder for the flow's list steps. */
export function StepListSkeleton({ rowClassName }: { rowClassName: string }) {
  return (
    <div aria-busy="true" className="grid gap-3">
      {SKELETON_ROW_IDS.map((id) => (
        <SkeletonBlock className={rowClassName} key={id} />
      ))}
    </div>
  );
}

/** A quiet inline notice for empty, error, and degraded states. */
export function StepNotice({
  children,
  tone = "quiet",
}: {
  children: ReactNode;
  tone?: "quiet" | "error";
}) {
  return (
    <p
      className={cn(
        "rounded-xl border px-3.5 py-3 text-[13px] leading-5",
        tone === "error"
          ? "border-error-border bg-error-bg text-error"
          : "border-border-subtle bg-fill-subtle text-secondary"
      )}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </p>
  );
}

/** Screen-reader-only live region announcing the current selection. */
export function SelectionAnnouncement({ children }: { children: string }) {
  return (
    <p aria-live="polite" className="sr-only" role="status">
      {children}
    </p>
  );
}
