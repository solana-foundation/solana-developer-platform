"use client";

import { createContext } from "react";

/** A page title that is data (a contact's name), with the route it belongs to. */
export interface DashboardPageTitleOverride {
  pathname: string;
  title: string;
}

/**
 * The shell's setter for the header title. A page whose title is data names itself through
 * `DashboardPageTitle`; the route's config title shows until it does (and after it unmounts).
 */
export const DashboardPageTitleContext = createContext<
  ((override: DashboardPageTitleOverride | null) => void) | null
>(null);
