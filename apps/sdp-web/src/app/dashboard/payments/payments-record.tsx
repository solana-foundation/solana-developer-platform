"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

// The design's record pages (a transaction, a payment request): the state as a tinted band,
// the amount at 40px, then label and value rows in two columns, and titled sections below.

const BAND_TONE: Record<StatusTone, string> = {
  positive: "bg-success/7 dark:bg-success/12",
  progress: "bg-info/7 dark:bg-info/12",
  attention: "bg-warning/7 dark:bg-warning/12",
  critical: "bg-error/7 dark:bg-error/12",
  neutral: "bg-fill-subtle",
};

/**
 * Where the record stands: the state in its colour, a line on why, and what can be done about
 * it at the band's end. Flat: the tint is the status colour, nothing is raised.
 */
export function RecordStateBand({
  state,
  tone,
  why,
  action,
}: {
  state: string;
  tone: StatusTone;
  why?: string;
  action?: ReactNode;
}) {
  return (
    <div
      data-slot="state-band"
      className={cn(
        "flex flex-col items-start gap-3 rounded-[var(--corner-card)] px-4 py-3 @2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-6",
        BAND_TONE[tone]
      )}
    >
      <div className="flex w-full min-w-0 flex-col gap-0.5 @2xl:flex-1">
        <p className="text-nav font-medium">
          <StatusText tone={tone}>{state}</StatusText>
        </p>
        {why ? <p className="max-w-md text-nav text-secondary">{why}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** The record's amount: a 13px label 7px over the 40px figure; `muted` when nothing moved. */
export function RecordAmount({
  label,
  muted = false,
  children,
}: {
  label: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.75">
      <span className="text-meta text-secondary">{label}</span>
      <p
        className={cn(
          "min-w-0 break-words text-amount font-medium tabular-nums",
          muted ? "text-tertiary" : "text-primary"
        )}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * Two columns of rows 48px apart from 42rem; on a phone they stack, a rule between them where
 * the first column's last row has none.
 */
export function RecordColumns({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-12 @2xl:grid-cols-2 [&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-border-subtle @2xl:[&>*:not(:last-child)]:border-b-0">
      {children}
    </div>
  );
}

/** One column of rows. */
export function RecordList({ children }: { children: ReactNode }) {
  return <dl className="flex min-w-0 flex-col">{children}</dl>;
}

/**
 * A label and its value on one 41px rule: 13px, then 14px. `copy` puts a copy button after the
 * value for the full text a shortened value stands for.
 */
export function RecordRow({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="record-row"
      className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0"
    >
      <dt className="shrink-0 text-meta leading-5 text-secondary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-right text-body text-primary">
        <span className="min-w-0 truncate">{children}</span>
        {copy ? <RecordCopyButton value={copy} label={label} /> : null}
      </dd>
    </div>
  );
}

/** A titled part of the record: an 18px heading 32px under what is above, its rows 14px under. */
export function RecordSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5 pt-8">
      <h2 className="text-subheading font-medium text-primary">{title}</h2>
      {children}
    </section>
  );
}

const COPIED_MS = 1500;

/** The design's 24px copy button: the tertiary glyph, a check in the success colour once copied. */
function RecordCopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error(t("DashboardPayments.record.copyFailed"));
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <button
      type="button"
      aria-label={t("DashboardPayments.record.copyField", { field: label.toLowerCase() })}
      onClick={() => void copy()}
      className={cn(
        "relative -my-0.5 inline-grid size-6 shrink-0 place-items-center rounded-sm text-tertiary outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]",
        copied && "text-success hover:text-success"
      )}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? t("DashboardPayments.record.copied") : ""}
      </span>
    </button>
  );
}

/** A record that could not be read: says so, that nothing changed, and offers to try again. */
export function RecordLoadError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  const t = useTranslations();
  return (
    <div role="alert" className="flex flex-col items-start gap-1">
      <p className="text-subheading font-medium text-primary">{title}</p>
      <p className="max-w-md text-nav text-secondary">{description}</p>
      <Button type="button" size="sm" className="mt-1.5" onClick={onRetry}>
        {t("DashboardPayments.record.tryAgain")}
      </Button>
    </div>
  );
}
