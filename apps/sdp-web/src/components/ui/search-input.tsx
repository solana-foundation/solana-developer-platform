"use client";

import { Loader2, Search, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type SearchInputProps = Omit<ComponentProps<typeof Input>, "iconLeft" | "iconRight" | "action"> & {
  /** Shows a spinner while a debounced or server-answered search is in flight. */
  pending?: boolean;
  /** Renders a clear button while the value is non-empty, and clears on Escape. */
  clear?: { label: string; onClear: () => void };
};

/**
 * The one search field every workspace toolbar shares: the DS filled field with
 * a leading search icon, an optional pending spinner for server-driven lists,
 * and an optional clear affordance (X button + Escape). The aria-label falls
 * back to the placeholder so a bare usage stays labelled.
 */
export function SearchInput({
  pending = false,
  clear,
  value,
  onKeyDown,
  placeholder,
  "aria-label": ariaLabel,
  ...props
}: SearchInputProps) {
  const hasValue = typeof value === "string" && value.length > 0;

  return (
    <Input
      // The searchbox role without type="search", so the browser's own clear
      // affordance never doubles the component's X button.
      role="searchbox"
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      iconLeft={<Search />}
      iconRight={pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      onKeyDown={(event) => {
        if (clear && hasValue && event.key === "Escape") {
          clear.onClear();
        }
        onKeyDown?.(event);
      }}
      action={
        clear && hasValue ? (
          <button
            type="button"
            aria-label={clear.label}
            onClick={clear.onClear}
            className="rounded text-tertiary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
          >
            <XIcon className="size-5" />
          </button>
        ) : undefined
      }
      {...props}
    />
  );
}
