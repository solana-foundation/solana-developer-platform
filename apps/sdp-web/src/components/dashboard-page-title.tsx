"use client";

import { usePathname } from "next/navigation";
import { useContext, useLayoutEffect } from "react";
import { DashboardPageTitleContext } from "@/components/dashboard-page-title-context";

/**
 * Names the page in the shell's header when the title is data, as a contact's page is titled
 * by the contact. Set in a layout effect so a client navigation paints the name with the page;
 * a hard load shows the route's own title until hydration.
 *
 * @param props.title - The header title for the current route.
 * @returns Nothing; the shell renders the title.
 */
export function DashboardPageTitle({ title }: { title: string }) {
  const setTitle = useContext(DashboardPageTitleContext);
  const pathname = usePathname();
  useLayoutEffect(() => {
    setTitle?.({ pathname, title });
    return () => setTitle?.(null);
  }, [setTitle, pathname, title]);
  return null;
}
