"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Children, isValidElement, type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";

type SelectSize = "lg" | "xl";

interface UiSelectProps {
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

function collectItemLabels(children: ReactNode): Record<string, ReactNode> {
  const items: Record<string, ReactNode> = {};
  for (const child of Children.toArray(children)) {
    if (isValidElement<UiSelectItemProps>(child) && child.type === SelectItem) {
      items[child.props.value] = child.props.children;
    }
  }
  return items;
}

function Select({
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
      value={value == null || value === "" ? null : value}
      onValueChange={(next) => onValueChange?.(next)}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        className={cn(
          "group/select relative flex w-full cursor-pointer items-center gap-2 text-left",
          disabled && "pointer-events-none opacity-40",
          size === "xl"
            ? "h-[var(--input-height-xl)] rounded-[var(--input-radius-xl)] px-[var(--input-padding-x-xl)]"
            : "h-[var(--input-height-lg)] rounded-[var(--input-radius-lg)] px-[var(--input-padding-x-lg)]",
          className
        )}
      >
        <span
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit] border-[length:var(--input-border-width)]",
            "border-[var(--input-border-idle)] bg-[var(--input-bg-idle)] transition-colors duration-150",
            "group-[:not([data-popup-open])]/select:group-hover/select:border-[var(--input-border-hover)]",
            "group-[:not([data-popup-open])]/select:group-hover/select:bg-[var(--input-bg-hover)]",
            "group-[[data-popup-open]]/select:border-[var(--input-border-focus)]"
          )}
        />
        {iconLeft && (
          <span className="pointer-events-none relative shrink-0 text-text-medium [&_svg]:size-5">
            {iconLeft}
          </span>
        )}
        <BaseSelect.Value
          className="relative min-w-0 flex-1 truncate text-sm text-text-extra-high"
          placeholder={<span className="text-[var(--input-placeholder-color)]">{placeholder}</span>}
        />
        {trailing && (
          <span className="pointer-events-none relative shrink-0 text-xs text-text-low">
            {trailing}
          </span>
        )}
        <BaseSelect.Icon className="relative inline-flex shrink-0 items-center justify-center text-text-medium transition-transform duration-150 group-[[data-popup-open]]/select:rotate-180">
          <ChevronDownIcon className="size-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border border-border-light bg-white p-1 shadow-lg outline-none">
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
        "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-text-extra-high outline-none",
        "data-[highlighted]:bg-[var(--input-bg-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className
      )}
    >
      <BaseSelect.ItemText className="min-w-0 truncate">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="shrink-0 text-text-medium">
        <CheckIcon className="size-4" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export { Select, SelectItem };
