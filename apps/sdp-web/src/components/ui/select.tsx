import {
  Select as DesignSystemSelect,
  SelectItem,
  type SelectProps,
} from "@solana/design-system/select";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type UiSelectProps = SelectProps & {
  /** Persistent leading icon on the trigger only (not repeated on each option). */
  iconLeft?: ReactNode;
  /** Muted trailing content rendered inside the trigger (before the chevron). */
  trailing?: ReactNode;
};

function Select({ className, size = "lg", iconLeft, trailing, ...props }: UiSelectProps) {
  if (!iconLeft && !trailing) {
    return <DesignSystemSelect className={className} data-slot="select" size={size} {...props} />;
  }

  return (
    <div className="relative w-full">
      {iconLeft && (
        <span className="pointer-events-none absolute top-1/2 left-3.5 z-10 -translate-y-1/2 text-text-medium [&_svg]:size-5">
          {iconLeft}
        </span>
      )}
      {trailing && (
        <span className="pointer-events-none absolute top-1/2 right-10 z-10 -translate-y-1/2 text-xs text-text-low">
          {trailing}
        </span>
      )}
      <DesignSystemSelect
        className={cn(iconLeft && "!pl-10", className)}
        data-slot="select"
        size={size}
        {...props}
      />
    </div>
  );
}

export { Select, SelectItem };
