import type { ReactNode } from "react";
import { TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PAYMENTS_TABLE_HEAD } from "./payments-table";

export interface PaymentsTableColumn {
  /** Stable React key for the column. */
  id: string;
  /** The heading; a column without a visible one passes screen-reader text. */
  label: ReactNode;
  /** Classes added to the heading cell, such as `text-right` for an amount. */
  className?: string;
}

/**
 * The heading row of a redesigned Payments list table, in the design's 13px regular type.
 *
 * @param props.columns - The columns, left to right.
 */
export function PaymentsTableHeader({ columns }: { columns: readonly PaymentsTableColumn[] }) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((column) => (
          <TableHead key={column.id} className={cn(PAYMENTS_TABLE_HEAD, column.className)}>
            {column.label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}
