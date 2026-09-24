"use client";

import type { ReactNode } from "react";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export const LIST_PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * A list's control row: filters on the left; page size and search on the right. Wraps to two
 * rows on narrow screens.
 */
export function ListToolbar({
  filters,
  children,
  className,
}: {
  filters?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">{filters}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3 sm:flex-nowrap">
        {children}
      </div>
    </div>
  );
}

/** "25 rows ⌄": how many rows a page shows. */
export function RowsPerPageSelect({
  value,
  onChange,
  sizes = LIST_PAGE_SIZES,
}: {
  value: number;
  onChange: (value: number) => void;
  sizes?: readonly number[];
}) {
  const t = useTranslations();
  return (
    <Select
      ariaLabel={t("Shared.SharedComponents.rowsPerPage")}
      value={String(value)}
      onValueChange={(next) => {
        const size = Number(next);
        if (Number.isFinite(size)) onChange(size);
      }}
      className="w-auto shrink-0"
    >
      {sizes.map((size) => (
        <SelectItem key={size} value={String(size)}>
          {t("Shared.SharedComponents.rowsCount", { count: size })}
        </SelectItem>
      ))}
    </Select>
  );
}
