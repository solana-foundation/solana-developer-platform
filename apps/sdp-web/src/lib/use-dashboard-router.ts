"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { announceDashboardNavigation } from "./dashboard-navigation-loading";

/** Next router with immediate dashboard pending feedback for cross-route changes. */
export function useDashboardRouter() {
  const router = useRouter();
  const push = useCallback<typeof router.push>(
    (href, options) => {
      announceDashboardNavigation(href);
      router.push(href, options);
    },
    [router]
  );
  const replace = useCallback<typeof router.replace>(
    (href, options) => {
      announceDashboardNavigation(href);
      router.replace(href, options);
    },
    [router]
  );

  return useMemo(() => ({ ...router, push, replace }), [router, push, replace]);
}
