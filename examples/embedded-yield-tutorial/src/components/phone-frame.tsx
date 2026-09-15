import { BatteryFullIcon, SignalIcon, WifiIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A faux mobile phone drawn with plain CSS: dark bezel, dynamic island,
 * status bar, and home indicator. The children render inside the screen.
 */
export function PhoneFrame({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative w-[320px] shrink-0 rounded-[3rem] bg-foreground p-[10px] shadow-2xl shadow-foreground/25 ${className}`}
    >
      <div className="relative h-[640px] overflow-hidden rounded-[2.4rem] bg-background">
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-2.5 z-20 h-6 w-24 -translate-x-1/2 rounded-full bg-foreground"
        />
        <div className="relative z-10 flex items-center justify-between px-7 pt-3.5 text-xs font-semibold text-foreground">
          <span>9:41</span>
          <span className="flex items-center gap-1.5">
            <SignalIcon className="size-3.5" />
            <WifiIcon className="size-3.5" />
            <BatteryFullIcon className="size-4" />
          </span>
        </div>
        {children}
        <div
          aria-hidden="true"
          className="absolute bottom-2 left-1/2 z-20 h-1 w-24 -translate-x-1/2 rounded-full bg-foreground/25"
        />
      </div>
    </div>
  );
}
