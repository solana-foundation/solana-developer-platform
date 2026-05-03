import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgRole, orgId, userId } = await auth();

  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);

  return (
    <DashboardWorkspaceProvider
      dashboardAccess={dashboardAccess}
      dashboardCacheScope={{ orgId: orgId ?? null, userId: userId ?? null }}
    >
      <NetworkDebugProvider>
        <DashboardShell>{children}</DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
