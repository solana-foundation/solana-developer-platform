"use client";

import { ChevronRight } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { JsonCodeBlock } from "@/components/ui/code-block";
import { HeightReveal } from "@/components/ui/height-reveal";
import { cn } from "@/lib/utils";

/**
 * Inline "raw details" toggle for audit records: a text trigger that reveals
 * the value as a JSON code block, animated open/closed like the revision
 * history explorer's raw-rule reveal.
 *
 * @param props.value - The record rendered as pretty-printed JSON.
 * @param props.label - Trigger text.
 * @param props.filename - Title shown in the code block header.
 * @returns The trigger with its animated code block.
 */
export function PolicyAuditRawDetails({
  value,
  label,
  filename,
}: {
  value: unknown;
  label: string;
  filename: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="w-fit cursor-pointer text-xs text-secondary transition-colors hover:text-primary"
      >
        {label}
        <ChevronRight
          className={cn("ml-1 inline size-3 transition-transform", open && "rotate-90")}
        />
      </button>
      <AnimatePresence>
        {open ? (
          <HeightReveal key="raw-details">
            <div className="p-px pt-3">
              <JsonCodeBlock value={value} title={filename} viewportClassName="max-h-96" />
            </div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
