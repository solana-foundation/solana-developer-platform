"use client";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover } from "radix-ui";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "./input";
import { Label } from "./label";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

interface ComboboxProps {
  value: string | null;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  label: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  icon?: ReactNode;
  isLoading?: boolean;
  disabled?: boolean;
  error?: string;
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
  isLoading,
  disabled,
  error,
  footer,
}: ComboboxProps) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

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
    if (!next) setQuery("");
  }

  function close() {
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-sm font-medium text-text-low" id={labelId}>
        {label}
      </Label>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-labelledby={labelId}
            disabled={disabled}
            className="flex h-12 w-full items-center gap-2 rounded-xl bg-border-extra-light px-3.5 text-base transition-colors hover:bg-border-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-white/50"
          >
            {icon}
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
            <ChevronDownIcon
              className={cn(
                "size-5 shrink-0 text-text-low transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            sideOffset={8}
            align="start"
            style={{ width: "var(--radix-popover-trigger-width)" }}
            className="z-20 overflow-hidden rounded-[var(--select-popup-radius)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)]"
          >
            {searchable ? (
              <div className="border-b border-border-light p-2">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-low" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
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
                filtered.map((option) => {
                  const active = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[var(--select-item-radius)] px-3 py-2.5 text-left transition-colors",
                        active
                          ? "bg-[var(--select-item-highlight-bg)]"
                          : "hover:bg-[var(--select-item-highlight-bg)]"
                      )}
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
    </div>
  );
}
