import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgRole, orgId, userId } = await auth();
  const dashboardAccess = resolveDashboardAccess(orgRole);

  return (
    <DashboardWorkspaceProvider
      dashboardAccess={dashboardAccess}
      dashboardCacheScope={{ orgId: orgId ?? null, userId: userId ?? null }}
    >
      <DashboardShell>{children}</DashboardShell>
    </DashboardWorkspaceProvider>
  );
}
