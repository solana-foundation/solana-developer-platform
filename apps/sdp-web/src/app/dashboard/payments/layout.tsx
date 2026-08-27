import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { payments } from "@/flags";

export default async function PaymentsLayout({ children }: { children: ReactNode }) {
  // Module-level gate mirroring markets/layout.tsx: one flag read here 404s
  // every Payments surface (transactions, counterparty, pay, deposit,
  // requests, recurring) on hand-typed URLs, so child segments hold no flag
  // checks and keep streaming their own loading.tsx on hard navigations.
  if (!(await payments())) {
    notFound();
  }

  return <>{children}</>;
}
