"use client";

/**
 * The one destructive note every vault modal raises under its form: a
 * role="alert" paragraph, so a failed submit or cancelled request is
 * announced rather than only painted.
 */
export function EarnErrorNote({ message }: { message: string }) {
  return (
    <p
      className="mt-3 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
      role="alert"
    >
      {message}
    </p>
  );
}
