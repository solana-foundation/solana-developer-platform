import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function ProviderSelectionCardBody({
  badge,
  description,
  icon,
  isMuted,
  isSelectable,
  title,
}: {
  badge?: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  isMuted: boolean;
  isSelectable: boolean;
  title: ReactNode;
}) {
  return (
    <span className="flex items-start gap-4">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-strong text-primary",
          isMuted && "opacity-60"
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "relative inline-block text-[22px] leading-none font-medium",
              isMuted ? "text-secondary" : "text-primary",
              isSelectable &&
                "after:absolute after:left-0 after:-bottom-1 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 group-hover:after:scale-x-100 group-focus-visible:after:scale-x-100 motion-reduce:after:transition-none"
            )}
          >
            {title}
          </span>
          {badge}
        </span>
        <span className="block text-sm leading-5 text-tertiary">{description}</span>
      </span>
    </span>
  );
}

export function ProviderSelectionCard({
  action,
  badge,
  description,
  icon,
  isSelectable = true,
  isSelected,
  onSelect,
  title,
  advanceOnEnter = false,
}: {
  /** Trailing control for a provider that cannot be selected, such as a request-access link. */
  action?: ReactNode;
  badge?: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  /** A provider worth showing that this organization cannot pick yet. */
  isSelectable?: boolean;
  isSelected: boolean;
  onSelect: () => void;
  title: ReactNode;
  advanceOnEnter?: boolean;
}) {
  // Muted means "nothing to do here" — a provider that cannot be picked but
  // still offers an action is not dimmed.
  const body = (
    <ProviderSelectionCardBody
      badge={badge}
      description={description}
      icon={icon}
      isMuted={!isSelectable && !action}
      isSelectable={isSelectable}
      title={title}
    />
  );

  // A provider that cannot be selected is not a button: it has no card-level
  // action, and any control it does carry must stay independently focusable.
  if (!isSelectable) {
    return (
      <div
        data-provider-selection-card="true"
        data-provider-selectable="false"
        className="w-full rounded-2xl border border-border-subtle bg-surface-raised px-5 py-5 text-left"
      >
        {body}
        {action ? <div className="mt-4 pl-15">{action}</div> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      data-provider-selection-card="true"
      data-provider-selectable="true"
      data-wallet-enter-advance={advanceOnEnter ? "true" : undefined}
      className={cn(
        "group w-full cursor-pointer rounded-2xl border px-5 py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-2",
        isSelected
          ? "border-primary bg-fill-subtle"
          : "border-border-default bg-surface-raised hover:bg-fill-subtle"
      )}
      aria-pressed={isSelected}
    >
      {body}
    </button>
  );
}
