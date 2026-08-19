import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { earn } from "@/flags";

/** Treasury is provider-backed by the Earn API and must inherit the same runtime gate. */
export default async function TreasurySolutionsLayout({ children }: { children: ReactNode }) {
  if (!(await earn())) notFound();
  return <>{children}</>;
}
