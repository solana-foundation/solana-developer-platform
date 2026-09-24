"use client";

import { ListFilterIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface FilterMenuSection {
  id: string;
  label: string;
  /** The current value's label, shown muted beside the section name; omit when unset. */
  value?: string;
  /** The submenu body, usually a {@link FilterMenuOptions}. */
  content: ReactNode;
}

// Keys the menu itself must still see while the search field has focus: Escape closes it and
// the arrows move into the list. Everything else stays in the field, so typing a letter types
// it instead of triggering the menu's typeahead.
const MENU_KEYS = new Set(["Escape", "ArrowDown", "ArrowUp", "Tab"]);

/**
 * A single "Filter" button that opens every filter a list supports as a searchable menu of
 * submenus (State ›, Type ›, …). The list owns the values; each section renders its own body.
 */
export function FilterMenu({
  label,
  searchPlaceholder,
  sections,
  className,
}: {
  label: string;
  searchPlaceholder: string;
  sections: readonly FilterMenuSection[];
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sections.filter((section) => section.label.toLowerCase().includes(needle))
    : sections;
  const activeCount = sections.filter((section) => section.value !== undefined).length;

  return (
    <DropdownMenu onOpenChange={(open) => (open ? null : setQuery(""))}>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-control-sm shrink-0 items-center gap-2 rounded-control border border-border-strong bg-fill-subtle px-3 text-body font-medium text-primary transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:bg-fill",
          className
        )}
      >
        <ListFilterIcon className="size-4" aria-hidden="true" />
        {label}
        {activeCount > 0 ? (
          <span className="rounded-control-inner bg-fill px-1.5 text-meta tabular-nums text-secondary">
            {activeCount}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border-default px-3">
          <SearchIcon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!MENU_KEYS.has(event.key)) event.stopPropagation();
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
          />
        </div>
        <div className="p-1.5">
          {visible.map((section) => (
            <DropdownMenuSub key={section.id}>
              <DropdownMenuSubTrigger className="gap-3 py-2.5 text-body font-normal">
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {section.value === undefined ? null : (
                  <span className="max-w-32 truncate text-meta text-tertiary">{section.value}</span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 min-w-56 overflow-y-auto">
                {section.content}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface FilterMenuOption {
  value: string;
  label: string;
}

/**
 * A filter's choices as a single-select list with an "any" entry first; picking "any" clears
 * the filter.
 */
export function FilterMenuOptions({
  value,
  anyLabel,
  options,
  onChange,
}: {
  value: string | undefined;
  anyLabel: string;
  options: readonly FilterMenuOption[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value ?? ""}
      onValueChange={(next) => onChange(next === "" ? undefined : next)}
    >
      <DropdownMenuRadioItem value="" className="text-body font-normal">
        {anyLabel}
      </DropdownMenuRadioItem>
      {options.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          className="text-body font-normal"
        >
          {option.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
