import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { earn, markets } from "@/flags";

export default async function MarketsLayout({ children }: { children: ReactNode }) {
  // Module-level gate: every routable Markets surface today (the landing
  // chooser, Treasury, Earn) is Earn-backed, so both flags are enforced once
  // here and child segments hold no flag checks of their own. A hand-typed URL
  // 404s before any child layout or page does auth or data work. Keeping the
  // flag reads out of child layouts also keeps hard navigations streaming each
  // child route's own loading.tsx: a child layout that suspends on a flag read
  // paints THIS segment's loading boundary instead. A future non-Earn Markets
  // sub-module moves the earn() half down into the Earn segments rather than
  // re-adding per-module copies of it.
  if (!(await markets()) || !(await earn())) {
    notFound();
  }

  return <>{children}</>;
}
