import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import type { ReactNode } from "react";

/**
 * The Markets info tip: a quiet round trigger whose tooltip carries one short
 * explanation. Treasury and the Embedded Yield portfolio spelled the same
 * radix shell three times with different sizes, so the a11y contract — an
 * `aria-label`led trigger, the label repeated as the tooltip text — lives
 * here once; callers own the trigger contents and the two class strings.
 */
export function InfoTip({
  ariaLabel,
  children,
  contentClassName,
  label,
  triggerClassName,
}: {
  /** The tooltip text, and the trigger's accessible name. */
  label: string;
  /** A distinct accessible name, when the trigger wraps more than an icon. */
  ariaLabel?: string;
  children: ReactNode;
  contentClassName: string;
  triggerClassName: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button aria-label={ariaLabel ?? label} className={triggerClassName} type="button">
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent className={contentClassName}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
