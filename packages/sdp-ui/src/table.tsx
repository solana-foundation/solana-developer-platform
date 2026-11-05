"use client";

import type { TableCellProps } from "@solana/design-system/table";
import type { Ref } from "react";
import { cn } from "./cn";

/**
 * A table cell: the design-system cell's `td` and classes, merged with the app's `cn`. The
 * design-system cell merges with its own tailwind-merge, which does not know the app's ink names,
 * so a cell's `text-primary` or `text-secondary` would keep its default `text-text-high` beside it,
 * and that one comes later in the stylesheet. Here a cell's own ink wins, as the design's tables
 * set names and amounts in full ink and dates and assets in the secondary one.
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
