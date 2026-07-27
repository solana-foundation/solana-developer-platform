"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption {
  value: string;
  label: string;
}

// A single-select segmented control backed by native <input type="radio">, so it
// is a real radio group: the browser provides arrow-key navigation + roving focus,
// and assistive tech announces "radio button, N of M, checked". Each input is
// visually hidden (sr-only) and its label span is the visible segment. (Native
// radios rather than role="radio" buttons — the latter lack the built-in keyboard
// and AT semantics, and misusing tablist/tab implies tabpanels that don't exist.)
export function SegmentedControl({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
  className,
  optionClassName,
  selectedClassName = "bg-surface-raised text-primary",
}: {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  optionClassName?: string;
  selectedClassName?: string;
}) {
  // Unique radio-group name so multiple controls on a page don't share a group.
  const groupName = useId();
  return (
    <fieldset
      className={cn(
        "flex min-w-0 rounded-lg border border-border-default bg-fill-subtle p-0.5",
        className
      )}
      disabled={disabled}
    >
      <legend className="sr-only">{ariaLabel}</legend>
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            className={cn("flex flex-1", disabled ? "cursor-not-allowed" : "cursor-pointer")}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span
              className={cn(
                "inline-flex flex-1 items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-primary",
                checked
                  ? selectedClassName
                  : cn("text-tertiary", !disabled && "peer-hover:text-primary"),
                optionClassName
              )}
            >
              {option.label}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
