"use client";

import { ArrowPagination } from "@sdp/ui/arrow-pagination";
import { cn } from "@sdp/ui/cn";
import { Select, SelectItem } from "@sdp/ui/select";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

interface PaginatedFooterProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Optional summary of the items shown, e.g. "1–10 of 42"; defaults to "Page x of y". */
  summary?: string;
  /** Block navigation while a page fetch is in flight. */
  disabled?: boolean;
  /** Renders a rows-per-page select when provided. */
  pageSizeControl?: {
    pageSize: number;
    onPageSizeChange: (pageSize: number) => void;
  };
  /** Extra footer content, grouped on the left after the page-size select. */
  children?: ReactNode;
  className?: string;
}

/**
 * Standard list footer: optional rows-per-page select and extra content on the
 * left, an ArrowPagination pager on the right.
 *
 * @param props - Pager state plus the optional page-size control and left-side content.
 * @returns The footer element.
 */
export function PaginatedFooter({
  page,
  pageCount,
  onPageChange,
  summary,
  disabled,
  pageSizeControl,
  children,
  className,
}: PaginatedFooterProps) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        "flex flex-col gap-4 border-t border-border-default p-4 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-4">
        {pageSizeControl ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-secondary">
              {t("Shared.SharedComponents.rowsPerPage")}
            </span>
            <Select
              value={String(pageSizeControl.pageSize)}
              onValueChange={(value) => pageSizeControl.onPageSizeChange(Number(value))}
              className="w-20"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </Select>
          </div>
        ) : null}
        {children}
      </div>
      <ArrowPagination
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        summary={summary}
        disabled={disabled}
      />
    </div>
  );
}
