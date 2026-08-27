import type { Metadata } from "next";
import EarnIntegrationHandoffPage from "@/app/earn/integrate/[token]/page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default EarnIntegrationHandoffPage;
