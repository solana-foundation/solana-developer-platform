"use client";

import { type ReactNode, useId } from "react";
import { cn } from "./cn";

export interface SegmentedOption {
  value: string;
  label: string;
  /** Draws the segment as this icon; the label stays as its accessible name. */
  icon?: ReactNode;
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
  selectedClassName = "bg-chip text-primary shadow-chip",
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
      className={cn("flex min-w-0 rounded-control border-0 bg-fill-subtle p-0.5", className)}
      disabled={disabled}
    >
      <legend className="sr-only">{ariaLabel}</legend>
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            className={cn(
              "relative flex flex-1",
              disabled ? "cursor-not-allowed" : "cursor-pointer"
            )}
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
                "inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-control-inner px-3 py-1 text-meta font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-primary",
                checked
                  ? selectedClassName
                  : cn("text-secondary", !disabled && "peer-hover:text-primary"),
                optionClassName
              )}
            >
              {option.icon ? (
                <>
                  <span aria-hidden="true" className="inline-flex [&_svg]:size-4">
                    {option.icon}
                  </span>
                  <span className="sr-only">{option.label}</span>
                </>
              ) : (
                option.label
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
