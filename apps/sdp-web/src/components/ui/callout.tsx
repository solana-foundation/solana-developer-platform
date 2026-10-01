import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type CalloutVariant = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * Variant names track `badge.tsx`, which already calls the error tokens `danger`.
 * Two names for one status would be worse than the mismatch between the variant
 * and the token it resolves to.
 *
 * `neutral` carries no status colour on purpose. It is for statements that are
 * neither good news nor bad — an outcome that could not be confirmed, or a
 * permission the viewer simply does not hold. Both were previously hand-rolled
 * from these same tokens precisely to avoid alarming a reader about something
 * that has not gone wrong.
 */
const variantClassNames: Record<CalloutVariant, string> = {
  neutral: "border-border-default bg-fill-subtle text-secondary",
  info: "border-info-border bg-info-bg text-info",
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  danger: "border-error-border bg-error-bg text-error",
};

const liveRoles: Record<CalloutVariant, "alert" | "status"> = {
  neutral: "status",
  info: "status",
  success: "status",
  warning: "alert",
  danger: "alert",
};

type CalloutProps = {
  children: ReactNode;
  className?: string;
  /**
   * Set when the callout appears in response to something the user did, rather
   * than rendering with the page. Static content is already read in document
   * order; wrapping it in a live region makes screen readers announce it out of
   * sequence, so this is opt-in rather than tied to the variant.
   */
  live?: boolean;
  title?: ReactNode;
  variant?: CalloutVariant;
};

/**
 * A bordered block of explanation or warning.
 *
 * The dashboard had no primitive for this, so every such block was hand-rolled
 * from the status tokens and none of them agreed on padding, radius or whether
 * they announced themselves.
 */
export function Callout({
  children,
  className,
  live = false,
  title,
  variant = "info",
}: CalloutProps) {
  return (
    <div
      className={cn("rounded-xl border px-4 py-3 text-sm", variantClassNames[variant], className)}
      role={live ? liveRoles[variant] : undefined}
    >
      {/* Deliberately not a heading: the callout does not know the outline of the
          page hosting it, and a guessed level would fight the real one. */}
      {title ? (
        <>
          <p className="font-medium">{title}</p>
          <div className="mt-1">{children}</div>
        </>
      ) : (
        // Untitled callouts stay transparent to the caller's layout. Wrapping here
        // would make the wrapper the only flex item, turning a requested row into
        // a column.
        children
      )}
    </div>
  );
}

export type { CalloutProps, CalloutVariant };
