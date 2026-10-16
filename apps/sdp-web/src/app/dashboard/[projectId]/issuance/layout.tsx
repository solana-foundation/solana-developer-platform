import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { issuance } from "@/flags";

export default async function IssuanceLayout({ children }: { children: ReactNode }) {
  if (!(await issuance())) {
    notFound();
  }

  return <>{children}</>;
}
