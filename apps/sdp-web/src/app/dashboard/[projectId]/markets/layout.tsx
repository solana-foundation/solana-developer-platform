import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

export default async function MarketsLayout({ children }: { children: ReactNode }) {
  // Module-level gate only: each sub-module (Earn, DvP) checks its own release
  // channel in its segment's layout. A hand-typed URL still 404s before any
  // child layout or page does auth or data work.
  if (!isModuleInDeploymentReleaseChannel("markets")) {
    notFound();
  }

  return <>{children}</>;
}
