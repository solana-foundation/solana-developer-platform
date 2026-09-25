import { cn } from "@/lib/utils";

/** The arrow-out-of-a-box mark the design puts after actions that lead into the product. */
export function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        "h-[13px] w-[13px] flex-none fill-none stroke-current opacity-75 [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.4]",
        className
      )}
    >
      <path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5" />
      <path d="M9.5 2H14v4.5M14 2 7.5 8.5" />
    </svg>
  );
}
