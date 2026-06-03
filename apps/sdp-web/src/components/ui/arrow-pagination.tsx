"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ArrowPaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  className?: string;
  /** Optional summary of the items shown, e.g. "1–10 of 42". */
  summary?: string;
}

export function ArrowPagination({
  page,
  pageCount,
  onPageChange,
  className,
  summary,
}: ArrowPaginationProps) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="text-xs text-text-medium">{summary ?? `Page ${page} of ${pageCount}`}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
