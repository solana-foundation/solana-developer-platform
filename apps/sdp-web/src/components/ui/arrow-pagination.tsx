"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
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
  const t = useTranslations();
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="text-xs text-text-medium">
        {summary ?? t("Shared.SharedComponents.pageOf", { page, pageCount })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("Shared.SharedComponents.previousPage")}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("Shared.SharedComponents.nextPage")}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
