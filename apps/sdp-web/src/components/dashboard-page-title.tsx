"use client";

import { type ReactNode, useContext, useLayoutEffect } from "react";
import { DashboardPageTitleContext } from "@/components/dashboard-page-title-context";
import { useDashboardPathname } from "@/lib/use-dashboard-project";

/**
 * Names the page in the shell's header when the title is data, as a contact's page is titled
 * by the contact. Set in a layout effect so a client navigation paints the name with the page;
 * a hard load shows the route's own title until hydration.
 *
 * @param props.title - The header title for the current route.
 * @param props.mark - Shown before the title (a wallet's provider mark).
 * @param props.actions - The page's own actions, before the route's header action. Pass a
 *   stable element (memoized), since a new one each render sets the header again.
 * @param props.alwaysVisible - Shows the title even where the route hides its own.
 * @returns Nothing; the shell renders the title.
 */
export function DashboardPageTitle({
  title,
  mark,
  actions,
  alwaysVisible,
}: {
  title: string;
  mark?: ReactNode;
  actions?: ReactNode;
  alwaysVisible?: true;
}) {
  const setTitle = useContext(DashboardPageTitleContext);
  const pathname = useDashboardPathname();
  useLayoutEffect(() => {
    setTitle?.({ pathname, title, mark, actions, alwaysVisible });
    return () => setTitle?.(null);
  }, [setTitle, pathname, title, mark, actions, alwaysVisible]);
  return null;
}
