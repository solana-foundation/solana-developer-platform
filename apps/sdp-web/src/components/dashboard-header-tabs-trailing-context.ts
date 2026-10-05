"use client";

import { createContext } from "react";

/**
 * The shell's slot at the right end of the header tab row, once it has mounted; null on a
 * route without header tabs. `DashboardHeaderTabsTrailing` portals a page's controls into it.
 */
export const DashboardHeaderTabsTrailingContext = createContext<HTMLElement | null>(null);
