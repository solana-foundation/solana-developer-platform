import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { markets } from "@/flags";

export default async function MarketsLayout({ children }: { children: ReactNode }) {
  // Module-level gate only. Until DvP, every routable Markets surface was
  // Earn-backed, so this layout enforced the earn flag too — and its own comment
  // said that "a future non-Earn Markets sub-module moves the earn() half down
  // into the Earn segments rather than re-adding per-module copies of it". DvP
  // is that sub-module, so `earn()` now lives in the Earn segments' own layouts
  // and this one holds the flag they all share.
  //
  // A hand-typed URL still 404s before any child layout or page does auth or
  // data work. Keeping the flag reads out of the shared layout also keeps hard
  // navigations streaming each child route's own loading.tsx: a child layout
  // that suspends on a flag read paints THIS segment's loading boundary instead.
  if (!(await markets())) {
    notFound();
  }

  return <>{children}</>;
}
