"use client";

import { createContext, type ReactNode } from "react";

/** A page title that is data (a contact's name), with the route it belongs to. */
export interface DashboardPageTitleOverride {
  pathname: string;
  title: string;
  /** Set before the title on a refresh page, as a wallet's provider mark is. */
  mark?: ReactNode;
  /** The page's own actions, before the route's header action (a wallet's favorite star). */
  actions?: ReactNode;
}

/**
 * The shell's setter for the header title. A page whose title is data names itself through
 * `DashboardPageTitle`; the route's config title shows until it does (and after it unmounts).
 */
export const DashboardPageTitleContext = createContext<
  ((override: DashboardPageTitleOverride | null) => void) | null
>(null);
