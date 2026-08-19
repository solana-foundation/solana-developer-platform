"use client";

import { Loader2, Search } from "lucide-react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<ComponentProps<typeof Input>, "type" | "iconLeft" | "iconRight"> & {
  /** Shows a spinner while a debounced or server-answered search is in flight. */
  pending?: boolean;
};

/**
 * The one search field every workspace toolbar shares: outlined 40px field,
 * leading search icon, searchbox role, and an optional pending spinner for
 * server-driven lists. The aria-label falls back to the placeholder so a
 * bare usage stays labelled.
 */
export function SearchInput({
  pending = false,
  className,
  placeholder,
  "aria-label": ariaLabel,
  ...props
}: SearchInputProps) {
  return (
    <Input
      type="search"
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      iconLeft={<Search />}
      iconRight={pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      // The DS input paints its border on an inner span via --input-border-*,
      // so border-* classes are inert — override the vars to 1px + shared
      // tokens to match the filter and toggle buttons beside it.
      className={cn(
        "h-10 rounded-[10px] bg-surface-raised [--input-border-hover:var(--color-border-strong)] [--input-border-idle:var(--color-border-default)] [--input-border-width:1px]",
        className
      )}
      {...props}
    />
  );
}
