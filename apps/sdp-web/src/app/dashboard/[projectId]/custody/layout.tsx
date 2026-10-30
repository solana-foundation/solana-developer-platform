import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

export default async function CustodyLayout({ children }: { children: ReactNode }) {
  if (!isModuleInDeploymentReleaseChannel("custody")) {
    notFound();
  }

  return <>{children}</>;
}
