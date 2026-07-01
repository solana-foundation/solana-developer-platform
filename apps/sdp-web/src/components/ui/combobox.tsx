"use client";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover } from "radix-ui";
import {
  cloneElement,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Input } from "./input";
import { Label } from "./label";
import { usePortalContainer } from "./portal-container";

const DEFAULT_ICON_CLASS = "size-5 shrink-0 text-text-low";

export type ComboboxSize = "md" | "lg" | "xl";

const SIZE_CLASSES = {
  md: "h-[var(--input-height-md)] rounded-[var(--input-radius-md)] px-[var(--input-padding-x-md)]",
  lg: "h-[var(--input-height-lg)] rounded-[var(--input-radius-lg)] px-[var(--input-padding-x-lg)]",
  xl: "h-[var(--input-height-xl)] rounded-[var(--input-radius-xl)] px-[var(--input-padding-x-xl)]",
} as const satisfies Record<ComboboxSize, string>;

function withIconClass(node: ReactNode): ReactNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node;
  }
  return cloneElement(node, { className: cn(DEFAULT_ICON_CLASS, node.props.className) });
}

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

interface ComboboxProps {
  value: string | null;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  label: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  size?: ComboboxSize;
  isLoading?: boolean;
  disabled?: boolean;
  error?: string;
  validationError?: string;
  onEnterSelect?: (value: string) => void;
  footer?: (close: () => void) => ReactNode;
}

export function Combobox({
  value,
  onChange,
  options,
  label,
  placeholder = "Select an option",
  searchable = true,
  searchPlaceholder = "Search…",
  icon,
  trailing,
  size = "xl",
  isLoading,
  disabled,
  error,
  validationError,
  onEnterSelect,
  footer,
}: ComboboxProps) {
  const labelId = useId();
  const portalContainer = usePortalContainer();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle)
    );
  }, [options, query, searchable]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setActiveIndex(-1);
    }
  }

  function close() {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  function selectOption(value: string, submit: boolean) {
    onChange(value);
    close();
    if (submit) {
      onEnterSelect?.(value);
    }
  }

  function selectOnlyMatch(submit = false) {
    if (filtered.length !== 1) return;
    selectOption(filtered[0].value, submit);
  }

  function selectActive(submit = false) {
    const active = filtered[activeIndex];
    if (!active) return false;
    selectOption(active.value, submit);
    return true;
  }

  useEffect(() => {
    setActiveIndex(filtered.length === 1 ? 0 : -1);
  }, [filtered]);

  return (
    <div className="flex flex-col gap-2">
      <Label id={labelId}>{label}</Label>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-labelledby={labelId}
            aria-invalid={validationError ? true : undefined}
            aria-describedby={validationError ? `${labelId}-error` : undefined}
            disabled={disabled}
            className={cn(
              "flex w-full items-center gap-2 border border-border-light bg-transparent text-base transition-colors hover:border-border-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-white/50",
              validationError && "border-status-error-border hover:border-status-error-border",
              SIZE_CLASSES[size]
            )}
          >
            {withIconClass(icon)}
            <span className="min-w-0 flex-1 text-left">
              {selected ? (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-text-extra-high">{selected.label}</span>
                  {selected.description ? (
                    <span className="truncate text-sm text-text-low">{selected.description}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-text-low">{placeholder}</span>
              )}
            </span>
            {trailing ? <span className="shrink-0">{trailing}</span> : null}
            <ChevronDownIcon
              className={cn(
                "size-5 shrink-0 text-text-low transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        </Popover.Trigger>

        <Popover.Portal container={portalContainer ?? undefined}>
          <Popover.Content
            sideOffset={8}
            align="start"
            style={{ width: "var(--radix-popover-trigger-width)" }}
            className="z-50 overflow-hidden rounded-[var(--select-popup-radius)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)]"
          >
            {searchable ? (
              <div className="border-b border-border-light p-2">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-low" />
                  <Input
                    autoFocus
                    aria-activedescendant={
                      activeIndex >= 0 ? `${labelId}-option-${activeIndex}` : undefined
                    }
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setActiveIndex((current) =>
                          filtered.length === 0 ? -1 : Math.min(current + 1, filtered.length - 1)
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActiveIndex((current) =>
                          filtered.length === 0 ? -1 : Math.max(current - 1, 0)
                        );
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!selectActive(true)) {
                          selectOnlyMatch(true);
                        }
                      }
                    }}
                    placeholder={searchPlaceholder}
                    className="pl-9"
                  />
                </div>
              </div>
            ) : null}

            <div className="max-h-56 overflow-y-auto p-1.5">
              {isLoading ? (
                <p className="px-3 py-6 text-center text-sm text-text-low">Loading…</p>
              ) : error ? (
                <p className="px-3 py-6 text-center text-sm text-status-error-text">{error}</p>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-text-low">
                  {options.length === 0 ? "No options available." : "No matches for your search."}
                </p>
              ) : (
                filtered.map((option, index) => {
                  const active = option.value === value;
                  const highlighted = index === activeIndex;
                  return (
                    <button
                      key={option.value}
                      id={`${labelId}-option-${index}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[var(--select-item-radius)] px-3 py-2.5 text-left transition-colors",
                        highlighted
                          ? "bg-[var(--select-item-highlight-bg)]"
                          : "hover:bg-[var(--select-item-highlight-bg)]"
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        onChange(option.value);
                        close();
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text-extra-high">{option.label}</span>
                        {option.description ? (
                          <span className="block truncate text-sm text-text-low">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {active ? (
                        <CheckIcon className="size-4 shrink-0 text-text-extra-high" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>

            {footer ? <div className="border-t border-border-light">{footer(close)}</div> : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {validationError ? (
        <p id={`${labelId}-error`} className="text-xs text-status-error-text">
          {validationError}
        </p>
      ) : null}
    </div>
  );
}
