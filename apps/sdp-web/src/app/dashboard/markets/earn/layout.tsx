import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { earn } from "@/flags";

/**
 * The Earn sub-module flag on this segment's legacy alias routes
 * (`/dashboard/markets/earn*`), which re-export the embedded-yield pages.
 *
 * Next serves this segment only behind the next.config redirect to
 * `/dashboard/markets/embedded-yield`, but a flag gate must not depend on a
 * routing redirect one line away in a different file: the layout is what makes
 * a hand-typed alias URL 404 before any page renders, the same contract every
 * other alias segment carries (`dashboard/wallets` for Custody).
 */
export default async function EarnLayout({ children }: { children: ReactNode }) {
  if (!(await earn())) {
    notFound();
  }

  return <>{children}</>;
}
