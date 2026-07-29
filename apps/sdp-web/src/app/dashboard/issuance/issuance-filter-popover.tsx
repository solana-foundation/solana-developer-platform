"use client";

import { Popover } from "@base-ui/react/popover";
import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  countActiveIssuanceFilters,
  DEFAULT_ISSUANCE_FILTERS,
  type IssuanceDateFilter,
  type IssuanceFilterState,
  type IssuanceSortOption,
  type IssuanceStatusFilter,
} from "./issuance-list-query";

// Filter + sort controls for the issuance asset grid/list. Rendered as an
// icon-only trigger in the workspace toolbar; the popover holds three dropdown
// filters (status, template, created date) plus a sort selector.
//
// Selections are request state, not view state: the workspace folds them into the
// list query the API answers (see issuance-list-query.ts), so filtering and
// sorting cover every asset in the project, not just the loaded page.

// Not a <label>: the DS Select renders a button trigger, not a native form
// control, so a wrapping label wouldn't associate. Each Select carries its own
// ariaLabel; this span is the visible caption.
function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-secondary">{label}</span>
      {children}
    </div>
  );
}

interface IssuanceFilterPopoverProps {
  filters: IssuanceFilterState;
  onChange: (changes: Partial<IssuanceFilterState>) => void;
  onClear: () => void;
  templateOptions: { value: string; label: string }[];
}

export function IssuanceFilterPopover({
  filters,
  onChange,
  onClear,
  templateOptions,
}: IssuanceFilterPopoverProps) {
  const t = useTranslations();
  const activeCount = countActiveIssuanceFilters(filters);
  const isDirty = activeCount > 0 || filters.sort !== DEFAULT_ISSUANCE_FILTERS.sort;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={t("DashboardIssuance.workspace.filters")}
        className={cn(
          "relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border bg-surface-raised outline-none transition-colors",
          "border-border-default text-secondary hover:border-border-strong hover:text-primary",
          "focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]",
          "data-[popup-open]:border-border-strong data-[popup-open]:text-primary"
        )}
      >
        <ListFilter className="h-4 w-4" />
        {activeCount > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-on-primary">
            {activeCount}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        {/* Above the workspace's pinned header (z-20) — the trigger lives in that
            header, so the panel drops across the rest of it — and below the DS popup
            layer (z-50), so the Selects inside this panel open above it rather than
            behind it. */}
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-30">
          <Popover.Popup className="w-72 rounded-[var(--select-popup-radius)] border border-[var(--select-popup-border)] bg-[var(--select-popup-bg)] p-4 shadow-[var(--select-popup-shadow)] outline-none">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-primary">
                {t("DashboardIssuance.workspace.filtersTitle")}
              </span>
              {isDirty ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-xs font-medium text-secondary underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:underline"
                >
                  {t("DashboardIssuance.workspace.clearFilters")}
                </button>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <FilterField label={t("DashboardIssuance.workspace.filterStatus")}>
                <Select
                  value={filters.status}
                  ariaLabel={t("DashboardIssuance.workspace.filterStatus")}
                  onValueChange={(value) =>
                    onChange({ status: (value as IssuanceStatusFilter) ?? "all" })
                  }
                >
                  <SelectItem value="all">{t("DashboardIssuance.workspace.statusAll")}</SelectItem>
                  <SelectItem value="draft">{t("DashboardIssuance.status.draft")}</SelectItem>
                  <SelectItem value="active">{t("DashboardIssuance.status.active")}</SelectItem>
                  <SelectItem value="paused">{t("DashboardIssuance.status.paused")}</SelectItem>
                </Select>
              </FilterField>

              <FilterField label={t("DashboardIssuance.workspace.filterTemplate")}>
                <Select
                  value={filters.template}
                  ariaLabel={t("DashboardIssuance.workspace.filterTemplate")}
                  onValueChange={(value) => onChange({ template: value ?? "all" })}
                >
                  <SelectItem value="all">
                    {t("DashboardIssuance.workspace.templateAll")}
                  </SelectItem>
                  {templateOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </Select>
              </FilterField>

              <FilterField label={t("DashboardIssuance.workspace.filterDate")}>
                <Select
                  value={filters.date}
                  ariaLabel={t("DashboardIssuance.workspace.filterDate")}
                  onValueChange={(value) =>
                    onChange({ date: (value as IssuanceDateFilter) ?? "all" })
                  }
                >
                  <SelectItem value="all">{t("DashboardIssuance.workspace.dateAll")}</SelectItem>
                  <SelectItem value="7d">{t("DashboardIssuance.workspace.date7d")}</SelectItem>
                  <SelectItem value="30d">{t("DashboardIssuance.workspace.date30d")}</SelectItem>
                  <SelectItem value="12m">{t("DashboardIssuance.workspace.date12m")}</SelectItem>
                </Select>
              </FilterField>

              <div className="h-px bg-fill-strong" />

              <FilterField label={t("DashboardIssuance.workspace.filterSort")}>
                <Select
                  value={filters.sort}
                  ariaLabel={t("DashboardIssuance.workspace.filterSort")}
                  onValueChange={(value) =>
                    onChange({ sort: (value as IssuanceSortOption) ?? "newest" })
                  }
                >
                  <SelectItem value="newest">
                    {t("DashboardIssuance.workspace.sortNewest")}
                  </SelectItem>
                  <SelectItem value="oldest">
                    {t("DashboardIssuance.workspace.sortOldest")}
                  </SelectItem>
                  <SelectItem value="name-asc">
                    {t("DashboardIssuance.workspace.sortNameAsc")}
                  </SelectItem>
                  <SelectItem value="name-desc">
                    {t("DashboardIssuance.workspace.sortNameDesc")}
                  </SelectItem>
                </Select>
              </FilterField>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
