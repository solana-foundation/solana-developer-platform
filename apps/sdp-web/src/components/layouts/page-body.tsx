import { cn } from "@/lib/utils";
import { type ReactNode } from "react";
import { getPageContentStyle } from "./page-layout";

interface PageBodyProps {
  children: ReactNode;
  fill?: boolean;
  className?: string;
}

export function PageBody({ children, fill = false, className }: PageBodyProps) {
  if (fill) {
    return <div className={cn("flex-1 overflow-hidden", className)}>{children}</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div
        className={cn("mx-auto w-full px-[var(--page-layout-inline-padding)] py-6", className)}
        style={getPageContentStyle()}
      >
        {children}
      </div>
    </div>
  );
}
