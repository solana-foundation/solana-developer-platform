"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopy } from "@/lib/use-copy";

/**
 * Icon-only copy control for an opaque identifier. The id stays out of the
 * layout: hovering reveals it in a tooltip, clicking copies it.
 *
 * @param props.value - The identifier revealed in the tooltip and copied on click.
 * @param props.label - Accessible name of the button, naming what gets copied.
 * @param props.copiedMessage - Toast text shown after the copy.
 */
export function CopyIdButton({
  value,
  label,
  copiedMessage,
}: {
  value: string;
  label: string;
  copiedMessage: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label={label}
            onClick={() => {
              void copy(value);
              toast.success(copiedMessage, { position: "bottom-right" });
            }}
          >
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
