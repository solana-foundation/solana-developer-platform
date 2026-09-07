import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { custody } from "@/flags";

export default async function CustodyLayout({ children }: { children: ReactNode }) {
  if (!(await custody())) {
    notFound();
  }

  return <>{children}</>;
}
