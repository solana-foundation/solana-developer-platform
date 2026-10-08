import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { policies } from "@/flags";

export default async function CustodyWalletPoliciesLayout({ children }: { children: ReactNode }) {
  if (!(await policies())) {
    notFound();
  }

  return <>{children}</>;
}
