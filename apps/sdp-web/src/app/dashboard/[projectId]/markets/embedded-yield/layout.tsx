import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { earn } from "@/flags";

/**
 * The Earn half of what used to be the shared Markets gate.
 *
 * Markets itself is gated one level up; this is the sub-module flag, held here
 * so a non-Earn sibling like DvP is not hidden by it.
 */
export default async function EmbeddedYieldLayout({ children }: { children: ReactNode }) {
  if (!(await earn())) {
    notFound();
  }

  return <>{children}</>;
}
