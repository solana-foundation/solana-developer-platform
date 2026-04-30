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
        "absolute top-4 right-4 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-[rgba(28,28,29,0.72)] shadow-sm transition-colors hover:bg-[rgba(28,28,29,0.08)] hover:text-[#1c1c1d] disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      {...props}
    >
      <X className="h-4 w-4" />
    </button>
  );
}
