import type * as React from "react";

import { cn } from "./cn";

/** A multi-line text field drawn with the design-system input states. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full rounded-xl border border-[var(--input-border-idle)] bg-[var(--input-bg-idle)] px-4 py-3 text-sm text-primary outline-none transition-[box-shadow,border-color] placeholder:text-muted",
        "hover:bg-[var(--input-bg-hover)] focus:border-[var(--input-border-focus)] focus:shadow-[0_0_0_2px_var(--input-focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
