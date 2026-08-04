import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { markets } from "@/flags";

export default async function MarketsLayout({ children }: { children: ReactNode }) {
  // Module-level gate: every Markets sub-module nests under this segment, so a
  // hand-typed URL 404s here before any child layout or page does auth or data
  // work. Sub-modules add their own flag on top (see earn/layout.tsx).
  if (!(await markets())) {
    notFound();
  }

  return <>{children}</>;
}
