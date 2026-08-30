import type { Metadata } from "next";
import EmbeddedYieldIntegrationHandoffPage from "@/app/embedded-yield/integrate/[token]/page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default EmbeddedYieldIntegrationHandoffPage;
