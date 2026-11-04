"use client";

import { cn } from "@sdp/ui/cn";
import { ChevronDownIcon } from "lucide-react";

/**
 * The 24px chevron at a row's end that opens its details, turned while they are open. The row
 * may toggle on a press too, so the button's own press stops there and toggles once.
 */
export function RowDisclosureButton({
  open,
  controls,
  label,
  onToggle,
}: {
  open: boolean;
  /** The id of the details the button opens, named only while they are rendered. */
  controls: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="-my-1 ms-auto inline-grid size-6 place-items-center rounded-sm text-tertiary outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]"
    >
      <ChevronDownIcon
        aria-hidden="true"
        className={cn("size-3.5 transition-transform", open && "rotate-180")}
      />
    </button>
  );
}
