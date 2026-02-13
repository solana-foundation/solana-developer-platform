import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-[#1c1c1d] placeholder:text-[rgba(28,28,29,0.45)] selection:bg-[#1c1c1d] selection:text-white h-10 w-full min-w-0 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 py-2 text-base text-[#1c1c1d] shadow-xs transition-[color,box-shadow,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-[rgba(28,28,29,0.32)] focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)]",
        "aria-invalid:ring-[rgba(199,31,55,0.2)] aria-invalid:border-[#c71f37]",
        className
      )}
      {...props}
    />
  );
}

export { Input };
