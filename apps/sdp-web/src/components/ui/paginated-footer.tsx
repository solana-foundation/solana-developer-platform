"use client";

import { type ReactNode, useCallback } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { replaceDashboardSearchParams, useDashboardSearchParam } from "@/lib/dashboard-url-state";
import { cn } from "@/lib/utils";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function parsePaginationParam(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

/**
 * URL-backed pagination state (`?page=` / `?pageSize=`) for client-paginated
 * lists rendering a PaginatedFooter, written shallowly like the rest of the
 * dashboard URL state. Invalid or missing params resolve to page 1 and the
 * caller's default page size; default values are omitted from the URL, and
 * changing the page size snaps back to page 1.
 *
 * @param defaultPageSize - Page size used when the URL carries no `pageSize`.
 * @returns The current page and page size plus setters that rewrite the URL.
 */
export function usePaginationUrlState(defaultPageSize: number): {
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
} {
  const page = parsePaginationParam(useDashboardSearchParam("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePaginationParam(useDashboardSearchParam("pageSize"), defaultPageSize, 100);
  const setPage = useCallback(
    (next: number) => replaceDashboardSearchParams({ page: next === 1 ? null : String(next) }),
    []
  );
  const setPageSize = useCallback(
    (next: number) =>
      replaceDashboardSearchParams({
        pageSize: next === defaultPageSize ? null : String(next),
        page: null,
      }),
    [defaultPageSize]
  );
  return { page, pageSize, setPage, setPageSize };
}

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
