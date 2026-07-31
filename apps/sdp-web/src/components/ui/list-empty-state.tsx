import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Centered empty/error state for list surfaces: optional icon tile, a message,
 * and an optional action. Fills the available height inside the full-height
 * flex chains used by dashboard list pages.
 *
 * @param props.icon - Icon rendered in the rounded tile above the message.
 * @param props.message - The state's headline text.
 * @param props.description - Optional supporting line below the message.
 * @param props.action - Optional CTA rendered below the message.
 * @param props.className - Extra classes merged onto the root.
 * @returns The centered state element.
 */
export function ListEmptyState({
  icon,
  message,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  message: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-72 flex-1 flex-col items-center justify-center px-6 text-center",
        className
      )}
    >
      {icon ? (
        <span className="flex size-11 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
          {icon}
        </span>
      ) : null}
      <p className="mt-4 text-sm font-medium text-primary first:mt-0">{message}</p>
      {description ? <p className="mt-1 text-sm text-secondary">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
