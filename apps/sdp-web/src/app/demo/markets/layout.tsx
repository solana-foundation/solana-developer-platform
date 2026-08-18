import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { MarketsDemoShell } from "./markets-demo-shell";

export const dynamic = "force-dynamic";

export default function MarketsDemoLayout({ children }: { children: ReactNode }) {
  if (process.env.SDP_MARKETS_DEMO !== "true") notFound();
  return <MarketsDemoShell>{children}</MarketsDemoShell>;
}
