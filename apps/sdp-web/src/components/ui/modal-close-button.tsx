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
        "absolute top-4 right-4 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-[rgba(28,28,29,0.48)] transition-colors hover:text-[#1c1c1d] focus-visible:text-[#1c1c1d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.18)] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-35",
        className
      )}
      {...props}
    >
      <X className="h-4 w-4" />
    </button>
  );
}
