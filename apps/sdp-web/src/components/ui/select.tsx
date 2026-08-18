"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Children, isValidElement, type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";

type SelectSize = "lg" | "xl";

/**
 * Maps an input size variant to the shared DS trigger height/radius/padding
 * classes, so selects and date pickers rendered side by side stay identical.
 *
 * @param size - The input size variant.
 * @returns The trigger sizing class list.
 */
function triggerSizeClassName(size: SelectSize): string {
  return size === "xl"
    ? "h-[var(--input-height-xl)] rounded-[var(--input-radius-xl)] px-[var(--input-padding-x-xl)]"
    : "h-[var(--input-height-lg)] rounded-[var(--input-radius-lg)] px-[var(--input-padding-x-lg)]";
}

interface UiSelectProps {
  ariaLabel?: string;
  /** Form field name; renders a hidden input so the value submits with a native form. */
  name?: string;
  /** Initial value for uncontrolled (form) usage. */
  defaultValue?: string;
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  size?: SelectSize;
  disabled?: boolean;
  className?: string;
  /** Persistent leading icon on the trigger only (not repeated on each option). */
  iconLeft?: ReactNode;
  /** Muted trailing content rendered inside the trigger (before the chevron). */
  trailing?: ReactNode;
  children: ReactNode;
}

interface UiSelectItemProps {
  value: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * Maps item values to their rendered labels for the trigger display.
 * Matches children structurally (string `value` prop) rather than by
 * `child.type === SelectItem`: element type identity does not survive the
 * RSC boundary, so the nominal check fails when Select is rendered from a
 * server component.
 *
 * @param children - The Select children to scan.
 * @returns Value-to-label map passed to the base-ui Select root.
 */
function collectItemLabels(children: ReactNode): Record<string, ReactNode> {
  const items: Record<string, ReactNode> = {};
  for (const child of Children.toArray(children)) {
    if (isValidElement<UiSelectItemProps>(child) && typeof child.props.value === "string") {
      items[child.props.value] = child.props.children;
    }
  }
  return items;
}

function Select({
  ariaLabel,
  name,
  defaultValue,
  value,
  onValueChange,
  placeholder,
  size = "lg",
  disabled,
  className,
  iconLeft,
  trailing,
  children,
}: UiSelectProps) {
  const items = useMemo(() => collectItemLabels(children), [children]);

  return (
    <BaseSelect.Root
      items={items}
      name={name}
      defaultValue={defaultValue}
      value={value === undefined ? undefined : value === "" ? null : value}
      onValueChange={(next) => onValueChange?.(next)}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          "group/select relative flex w-full cursor-pointer items-center gap-2 text-left",
          disabled && "pointer-events-none opacity-40",
          triggerSizeClassName(size),
          className
        )}
      >
        <span
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit] bg-fill-subtle",
            "group-[[data-popup-open]]/select:shadow-[0_0_0_2px_var(--input-focus-ring)]"
          )}
        />
        {iconLeft && (
          <span className="pointer-events-none relative shrink-0 text-secondary [&_svg]:size-5">
            {iconLeft}
          </span>
        )}
        <BaseSelect.Value
          className="relative min-w-0 flex-1 truncate text-sm text-primary"
          placeholder={<span className="text-[var(--input-placeholder-color)]">{placeholder}</span>}
        />
        {trailing && (
          <span className="pointer-events-none relative shrink-0 text-xs text-tertiary">
            {trailing}
          </span>
        )}
        <BaseSelect.Icon className="relative inline-flex shrink-0 items-center justify-center text-secondary transition-transform duration-150 group-[[data-popup-open]]/select:rotate-180">
          <ChevronDownIcon className="size-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border border-border-default bg-surface-raised p-1 shadow-lg outline-none">
            {children}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

function SelectItem({ value, children, className, disabled }: UiSelectItemProps) {
  return (
    <BaseSelect.Item
      value={value}
      disabled={disabled}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-primary outline-none",
        "data-[highlighted]:bg-[var(--input-bg-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className
      )}
    >
      <BaseSelect.ItemText className="min-w-0 truncate">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="shrink-0 text-secondary">
        <CheckIcon className="size-4" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export { Select, SelectItem, triggerSizeClassName };
