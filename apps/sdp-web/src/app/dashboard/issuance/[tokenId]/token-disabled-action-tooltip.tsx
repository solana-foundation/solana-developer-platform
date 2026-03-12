"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
          <span className="inline-flex w-fit">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
