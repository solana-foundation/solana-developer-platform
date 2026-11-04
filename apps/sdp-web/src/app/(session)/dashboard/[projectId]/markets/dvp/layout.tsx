import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { dvp } from "@/flags";

/**
 * The DvP sub-module gate. Markets is gated one level up.
 *
 * Worth knowing when enabling this: the swap program is deployed on devnet
 * only, so the API answers 403 on every other cluster whatever this flag says.
 */
export default async function DvpLayout({ children }: { children: ReactNode }) {
  if (!(await dvp())) {
    notFound();
  }

  return <>{children}</>;
}
