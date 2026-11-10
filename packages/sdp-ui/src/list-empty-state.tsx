import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Empty/error state for list surfaces: an 18px title, a 14px line held to 288px so it wraps as
 * the design's does, and the one action 24px under it, in a bounded block at the top of the page.
 *
 * @param props.message - The state's headline text.
 * @param props.description - Optional supporting line below the message.
 * @param props.action - Optional CTA rendered below the message.
 * @param props.hidesPageAction - The state's action repeats the page header's, so the header
 * hides its own while this state shows (the shell reads the attribute).
 * @param props.className - Extra classes merged onto the root.
 * @returns The centered state element.
 */
export function ListEmptyState({
  message,
  description,
  action,
  hidesPageAction = false,
  className,
}: {
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
        "flex h-auto min-h-0 flex-none flex-col items-center justify-start px-4 py-6 text-center",
        className
      )}
    >
      <p className="text-subheading font-medium text-primary">{message}</p>
      {description ? <p className="mt-2 max-w-72 text-body text-secondary">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
