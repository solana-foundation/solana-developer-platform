import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isModuleInProjectReleaseChannel } from "@/flags/project-release-channel";

export default async function CustodyLayout({ children }: { children: ReactNode }) {
  if (!(await isModuleInProjectReleaseChannel("custody"))) {
    notFound();
  }

  return <>{children}</>;
}
