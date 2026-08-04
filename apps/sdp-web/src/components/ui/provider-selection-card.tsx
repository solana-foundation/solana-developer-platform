import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ProviderSelectionCard({
  badge,
  description,
  icon,
  isSelected,
  onSelect,
  title,
  advanceOnEnter = false,
}: {
  badge?: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  title: ReactNode;
  advanceOnEnter?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-provider-selection-card="true"
      data-wallet-enter-advance={advanceOnEnter ? "true" : undefined}
      className={cn(
        "group w-full cursor-pointer rounded-2xl border px-5 py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-2",
        isSelected
          ? "border-primary bg-fill-subtle"
          : "border-border-default bg-surface-raised hover:bg-fill-subtle"
      )}
      aria-pressed={isSelected}
    >
      <span className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-strong text-primary">
          {icon}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="relative inline-block text-[22px] leading-none font-medium text-primary after:absolute after:left-0 after:-bottom-1 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 group-hover:after:scale-x-100 group-focus-visible:after:scale-x-100 motion-reduce:after:transition-none">
              {title}
            </span>
            {badge}
          </span>
          <span className="block text-sm leading-5 text-tertiary">{description}</span>
        </span>
      </span>
    </button>
  );
}
