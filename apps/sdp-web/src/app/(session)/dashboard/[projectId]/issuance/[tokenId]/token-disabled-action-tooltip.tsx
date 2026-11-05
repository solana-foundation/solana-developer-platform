"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import type { ReactNode } from "react";

interface TokenDisabledActionTooltipProps {
  reason?: string | null;
  children: ReactNode;
}

export function TokenDisabledActionTooltip({ reason, children }: TokenDisabledActionTooltipProps) {
  if (!reason) {
    return children;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex w-fit" role="note" aria-label={reason}>
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
