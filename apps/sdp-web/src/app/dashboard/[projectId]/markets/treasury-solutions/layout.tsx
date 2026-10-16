import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

/**
 * Treasury reads Earn provider contracts, so it carries the Earn flag even
 * though it is not the Earn workspace itself. Markets is gated one level up.
 */
export default async function TreasurySolutionsLayout({ children }: { children: ReactNode }) {
  if (!isModuleInDeploymentReleaseChannel("earn")) {
    notFound();
  }

  return <>{children}</>;
}
