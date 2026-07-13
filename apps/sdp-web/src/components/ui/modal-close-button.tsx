import { X } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ModalCloseButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "type"
> & {
  label: string;
};

export function ModalCloseButton({ className, label, ...props }: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "absolute top-4 right-4 z-20 inline-flex h-10 w-10 appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted shadow-none outline-none transition-colors hover:bg-transparent hover:text-primary focus-visible:bg-transparent focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-0 active:bg-transparent disabled:pointer-events-none disabled:opacity-35",
        className
      )}
      {...props}
    >
      <X aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}
