import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DASHBOARD_FEATURE_FLAGS } from "@/lib/dashboard-feature-flags";

export default function CounterpartyLayout({ children }: { children: ReactNode }) {
  if (!DASHBOARD_FEATURE_FLAGS.paymentsV2) {
    notFound();
  }

  return children;
}
