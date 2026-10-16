import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

export default async function IssuanceLayout({ children }: { children: ReactNode }) {
  if (!isModuleInDeploymentReleaseChannel("issuance")) {
    notFound();
  }

  return <>{children}</>;
}
