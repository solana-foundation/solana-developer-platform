"use client";

import {
  TableCell as DesignSystemTableCell,
  type TableCellProps,
} from "@solana/design-system/table";
import type { Ref } from "react";
import { useThemeScope } from "@/components/theme-scope";
import { cn } from "@/lib/utils";

export {
  Table,
  TableBody,
  TableCaption,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@solana/design-system/table";

/**
 * A table cell. The design-system cell merges classes with its own tailwind-merge, which does not
 * know the app's ink names, so a cell's `text-primary` or `text-secondary` kept its default
 * `text-text-high` beside it, and that one comes later in the stylesheet: every column read in
 * one grey. On a refresh surface this is the same `td` with the same classes, merged with the
 * app's `cn`, so a cell's own ink wins, as the design's tables set names and amounts in full ink
 * and dates and assets in the secondary one. Other surfaces keep the design-system cell as it is.
 */
export function TableCell({
  ref,
  className,
  align = "left",
  mono = false,
  numeric = false,
  pinned,
  ...props
}: TableCellProps & { ref?: Ref<HTMLTableCellElement> }) {
  const refresh = useThemeScope() === "refresh";
  if (!refresh) {
    return (
      <DesignSystemTableCell
        ref={ref}
        className={className}
        align={align}
        mono={mono}
        numeric={numeric}
        pinned={pinned}
        {...props}
      />
    );
  }
  return (
    <td
      ref={ref}
      className={cn(
        "whitespace-nowrap align-middle text-text-high",
        "border-[var(--table-border)] border-b",
        "ps-[var(--table-cell-padding-x)] pe-[var(--table-cell-padding-x)]",
        "first:ps-[var(--table-cell-padding-x-edge)] last:pe-[var(--table-cell-padding-x-edge)]",
        align === "left" && "text-left",
        align === "center" && "text-center",
        align === "right" && "text-right",
        mono && "font-berkeley-mono text-[var(--text-body-sm-size)]",
        numeric && "tabular-nums",
        pinned && "sticky z-10 bg-[var(--table-bg)]",
        pinned && "group-hover/row:bg-[var(--table-row-bg-hover-solid)]",
        pinned && "transition-colors duration-150 ease-out",
        pinned === "left" && "left-0 shadow-[inset_-1px_0_0_0_var(--table-border)]",
        pinned === "right" && "right-0 shadow-[inset_1px_0_0_0_var(--table-border)]",
        className
      )}
      style={{
        height: "var(--table-row-height)",
        paddingBlock: "var(--table-cell-padding-y)",
      }}
      {...props}
    />
  );
}
