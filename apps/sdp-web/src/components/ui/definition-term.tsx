"use client";

import { useId } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type DefinitionTermProps = {
  className?: string;
  /** Plain-language explanation. One sentence; this is a definition, not documentation. */
  definition: string;
  /** The term as it appears in the surrounding copy. */
  term: string;
};

/**
 * A term in body copy that can explain itself.
 *
 * The tooltip renders its content in a portal only once opened, so the
 * definition is *also* rendered as visually hidden text and referenced with
 * `aria-describedby`. Without that, the explanation would exist for people using
 * a pointer and for nobody else — which is decoration rather than guidance.
 *
 * There is deliberately no link inside the tooltip: reaching a link in a
 * hover-dismissed layer is awkward for keyboard and touch users, and the design
 * caps disclosure at two levels. Put a DocLink next to the sentence instead.
 */
export function DefinitionTerm({ className, definition, term }: DefinitionTermProps) {
  const definitionId = useId();

  return (
    <span className={cn("inline-flex items-baseline", className)}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-describedby={definitionId}
              className="cursor-help underline decoration-dotted underline-offset-4"
              type="button"
            >
              {term}
            </button>
          </TooltipTrigger>
          <TooltipContent>{definition}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className="sr-only" id={definitionId}>
        {definition}
      </span>
    </span>
  );
}

export type { DefinitionTermProps };
