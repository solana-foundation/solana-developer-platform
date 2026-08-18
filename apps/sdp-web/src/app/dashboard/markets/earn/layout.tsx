import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { earn } from "@/flags";

export default async function EarnLayout({ children }: { children: ReactNode }) {
  // Only the Earn sub-module switch: the parent Markets guard already ran, so
  // markets-off makes this segment unreachable without checking it again here.
  if (!(await earn())) {
    notFound();
  }

  return <>{children}</>;
}
