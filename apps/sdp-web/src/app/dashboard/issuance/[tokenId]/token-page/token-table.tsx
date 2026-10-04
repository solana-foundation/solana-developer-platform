"use client";

import type { ReactNode } from "react";
import { PAYMENTS_TABLE_HEAD } from "@/app/dashboard/payments/payments-table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** A column of a token-page table: its width and heading, the heading hidden when `srOnly`. */
export interface TokenTableColumn {
  className: string;
  label: string;
  srOnly?: boolean;
}

/**
 * The frame every token-page table shares: a horizontal scroller, fixed column widths and the
 * heading row; the rows go in as children. Like the Payments tables, it reaches one edge padding
 * past the content on each side, so the text lines up with the heading above while a hovered
 * row's band keeps that padding around it.
 */
export function TokenTable({
  columns,
  className,
  tableClassName,
  children,
}: {
  columns: TokenTableColumn[];
  className?: string;
  tableClassName: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(className, "overflow-x-auto refresh:-mx-3")}>
      <Table className={cn(tableClassName, "table-fixed rounded-none border-0")}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.label} className={column.className} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            {columns.map((column) =>
              column.srOnly ? (
                <TableHead key={column.label}>
                  <span className="sr-only">{column.label}</span>
                </TableHead>
              ) : (
                <TableHead key={column.label} className={PAYMENTS_TABLE_HEAD}>
                  {column.label}
                </TableHead>
              )
            )}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}
