"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ArrowPagination } from "@/components/ui/arrow-pagination";

export function MembersPagination({
  meta,
}: {
  meta: { total: number; page: number; pageSize: number; hasMore: boolean };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pageCount = Math.max(1, Math.ceil(meta.total / meta.pageSize));

  const goToPage = (nextPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    // Page 1 is the default, so it stays out of the URL.
    if (nextPage <= 1) {
      params.delete("membersPage");
    } else {
      params.set("membersPage", String(nextPage));
    }

    const query = params.toString();
    // Scroll is suppressed: the table is below the fold on this page and
    // jumping to the top after paging loses the reader's place.
    router.push(`/dashboard/settings${query ? `?${query}` : ""}`, { scroll: false });
  };

  return <ArrowPagination page={meta.page} pageCount={pageCount} onPageChange={goToPage} />;
}
