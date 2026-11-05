"use client";

import { ArrowPagination } from "@sdp/ui/arrow-pagination";
import { useRouter } from "next/navigation";
import { useProjectHref } from "@/lib/use-dashboard-project";

export function MembersPagination({
  meta,
}: {
  meta: { total: number; page: number; pageSize: number; hasMore: boolean };
}) {
  const router = useRouter();
  const href = useProjectHref();
  const pageCount = Math.max(1, Math.ceil(meta.total / meta.pageSize));

  const goToPage = (nextPage: number) => {
    // The live URL, not useSearchParams: a shallow tab switch (?tab=members) never reaches Next's copy.
    const params = new URLSearchParams(window.location.search);
    // Page 1 is the default, so it stays out of the URL.
    if (nextPage <= 1) {
      params.delete("membersPage");
    } else {
      params.set("membersPage", String(nextPage));
    }

    const query = params.toString();
    // Scroll is suppressed: the table is below the fold on this page and
    // jumping to the top after paging loses the reader's place.
    router.push(href(`/dashboard/settings${query ? `?${query}` : ""}`), { scroll: false });
  };

  return <ArrowPagination page={meta.page} pageCount={pageCount} onPageChange={goToPage} />;
}
