import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Selection-card grammar shared with the Markets path cards
 * (app/dashboard/markets/markets-landing.tsx): one source so the two surfaces
 * cannot drift. The underline grows by width rather than a scale-from-zero
 * transform, which React Doctor flags on any PR touching the file.
 */
export const providerSelectionCardIconClassName =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-strong text-primary";

export const providerSelectionCardTitleClassName =
  "relative inline-block text-[22px] leading-none font-medium";

export const providerSelectionCardTitleUnderlineClassName =
  "after:absolute after:left-0 after:-bottom-1 after:h-px after:w-0 after:bg-current after:transition-[width] after:duration-200 group-hover:after:w-full group-focus-visible:after:w-full motion-reduce:after:transition-none";

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
      <span className={cn(providerSelectionCardIconClassName, isMuted && "opacity-60")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              providerSelectionCardTitleClassName,
              isMuted ? "text-secondary" : "text-primary",
              isSelectable && providerSelectionCardTitleUnderlineClassName
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
