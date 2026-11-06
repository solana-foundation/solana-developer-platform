"use client";

import { createContext } from "react";

/**
 * The shell's slot at the right end of the header tab row, once it has mounted; null on a
 * route without header tabs. `DashboardHeaderTabsTrailing` portals a page's controls into it.
 */
export const DashboardHeaderTabsTrailingContext = createContext<HTMLElement | null>(null);

/**
 * Hides some of the route's header tabs, for a page whose data leaves them empty; null outside
 * the shell. `useHiddenHeaderTabs` sets it and clears it on unmount.
 */
export const DashboardHeaderTabsHideContext = createContext<
  ((tabIds: readonly string[]) => void) | null
>(null);
