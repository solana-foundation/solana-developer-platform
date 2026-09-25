import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Centered empty/error state for list surfaces: optional icon tile, a message,
 * and an optional action. Fills the available height inside the full-height
 * flex chains used by dashboard list pages.
 *
 * On a refresh surface it is the design's empty state instead: no icon, an 18px title, a 14px
 * line held to 288px so it wraps as the design's does, and the one action 24px under it, in a
 * bounded block at the top of the page rather than a centred one.
 *
 * @param props.icon - Icon rendered in the rounded tile above the message (base design only).
 * @param props.message - The state's headline text.
 * @param props.description - Optional supporting line below the message.
 * @param props.action - Optional CTA rendered below the message.
 * @param props.hidesPageAction - The state's action repeats the page header's, so the header
 * hides its own while this state shows (the shell reads the attribute).
 * @param props.className - Extra classes merged onto the root.
 * @returns The centered state element.
 */
export function ListEmptyState({
  icon,
  message,
  description,
  action,
  hidesPageAction = false,
  className,
}: {
  icon?: ReactNode;
  message: string;
  description?: string;
  action?: ReactNode;
  hidesPageAction?: boolean;
  className?: string;
}) {
  return (
    <div
      data-hides-page-action={hidesPageAction ? "" : undefined}
      className={cn(
        "flex h-full min-h-72 flex-1 flex-col items-center justify-center px-6 text-center",
        "refresh:h-auto refresh:min-h-0 refresh:flex-none refresh:justify-start refresh:px-4 refresh:py-6",
        className
      )}
    >
      {icon ? (
        <span className="flex size-11 items-center justify-center rounded-xl bg-fill-subtle text-secondary refresh:hidden">
          {icon}
        </span>
      ) : null}
      <p className="mt-4 text-sm font-medium text-primary first:mt-0 refresh:mt-0 refresh:text-subheading">
        {message}
      </p>
      {description ? (
        <p className="mt-1 text-sm text-secondary refresh:mt-2 refresh:max-w-72 refresh:text-body">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 refresh:mt-6">{action}</div> : null}
    </div>
  );
}
