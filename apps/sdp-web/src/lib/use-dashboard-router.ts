"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { announceDashboardNavigation } from "./dashboard-navigation-loading";

/** Next router with immediate dashboard pending feedback for cross-route changes. */
export function useDashboardRouter() {
  const router = useRouter();

  return useMemo(() => {
    const push: typeof router.push = (href, options) => {
      announceDashboardNavigation(href);
      router.push(href, options);
    };
    const replace: typeof router.replace = (href, options) => {
      announceDashboardNavigation(href);
      router.replace(href, options);
    };

    return { ...router, push, replace };
  }, [router]);
}
