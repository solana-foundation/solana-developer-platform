"use client";

import { CheckIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A row with a checkbox at its start, as the design's control lists draw it: a 20px box,
 * filled when on, a quiet grey fill when it is on and cannot change.
 */
export function IssuanceCheckRow({
  checked,
  disabled = false,
  onChange,
  children,
  aside,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  children: ReactNode;
  /** Shown at the row's end: a value, a lock, "Always on". */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "group flex items-start gap-3 border-b border-border-subtle py-3 last:border-b-0",
        disabled ? "cursor-default" : "cursor-pointer",
        className
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.currentTarget.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors peer-focus-visible:shadow-[0_0_0_2px_var(--input-focus-ring)] motion-reduce:transition-none",
          checked && disabled
            ? "border-transparent bg-fill-strong text-secondary"
            : checked
              ? "border-primary bg-primary text-on-primary"
              : "border-[var(--input-border-idle)]"
        )}
      >
        {checked ? <CheckIcon className="size-3.5" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      {aside ? <span className="flex shrink-0 items-center gap-2 self-center">{aside}</span> : null}
    </label>
  );
}

/** A lock beside a value that cannot change; the reason shows on hover and focus. */
export function LockHint({ text }: { text: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            className="-my-1.5 -me-1.5 inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-sm text-tertiary hover:text-primary"
          >
            <LockIcon className="size-3" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
