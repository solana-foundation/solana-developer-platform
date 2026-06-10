import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getDashboardFeatureFlags } from "@/lib/dashboard-feature-flags.server";

export default async function CounterpartyLayout({ children }: { children: ReactNode }) {
  const featureFlags = await getDashboardFeatureFlags();
  if (!featureFlags.paymentsV2) {
    notFound();
  }

  return children;
}
