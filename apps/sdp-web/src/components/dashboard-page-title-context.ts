"use client";

import { createContext, type ReactNode } from "react";

/** A page title that is data (a contact's name), with the route it belongs to. */
export interface DashboardPageTitleOverride {
  pathname: string;
  title: string;
  /** Set before the page's title, as a wallet's provider mark is. */
  mark?: ReactNode;
  /** The page's own actions, before the route's header action (a wallet's favorite star). */
  actions?: ReactNode;
  /** Set after the title on its line: the record's status word (a connection's Active). */
  badge?: ReactNode;
  /**
   * Makes the route's way back and the sidebar inert while leaving would drop work in flight
   * (a flow's request it cannot replay from anywhere else), as a modal's backdrop would.
   */
  navigationLocked?: true;
  /** Shown even on a route that hides its title, as a missing page has to say what happened. */
  alwaysVisible?: true;
}

/**
 * The shell's setter for the header title. A page whose title is data names itself through
 * `DashboardPageTitle`; the route's config title shows until it does (and after it unmounts).
 */
export const DashboardPageTitleContext = createContext<
  ((override: DashboardPageTitleOverride | null) => void) | null
>(null);
