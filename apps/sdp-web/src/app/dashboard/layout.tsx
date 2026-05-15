import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgRole, orgId, userId } = await auth();

  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const dashboardCacheScope = {
    orgId: orgId ?? null,
    userId: userId ?? null,
  } satisfies DashboardCacheScope;

  return (
    <DashboardWorkspaceProvider
      key={getDashboardCacheScopeKey(dashboardCacheScope)}
      dashboardAccess={dashboardAccess}
      serverDashboardCacheScope={dashboardCacheScope}
    >
      <NetworkDebugProvider>
        <DashboardShell>{children}</DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
