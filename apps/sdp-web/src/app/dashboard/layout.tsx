import type { Project } from "@sdp/types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getDashboardFlags } from "@/flags/dashboard";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { resolveDashboardProjectSelection } from "@/lib/dashboard-project-selection";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { getSdpAuth, listSdpProjects } from "@/lib/sdp-api";

async function loadProjects(): Promise<Project[] | null> {
  try {
    return await listSdpProjects();
  } catch {
    return null;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ orgRole, orgId, userId }, flags] = await Promise.all([
    getSdpAuth(),
    getDashboardFlags(),
  ]);

  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  if (!orgId) {
    return <SelectExistingOrganizationPanel />;
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const dashboardCacheScope = {
    orgId,
    userId,
  } satisfies DashboardCacheScope;

  const [loadedProjects, cookieStore] = await Promise.all([loadProjects(), cookies()]);
  const projects = loadedProjects ?? [];
  const cookieProjectId = cookieStore.get(PROJECT_COOKIE_NAME)?.value ?? null;
  const projectSelection = resolveDashboardProjectSelection(projects, cookieProjectId, {
    projectListIsAuthoritative: loadedProjects !== null,
  });

  return (
    <DashboardWorkspaceProvider
      key={getDashboardCacheScopeKey(dashboardCacheScope)}
      dashboardAccess={dashboardAccess}
      flags={flags}
      serverDashboardCacheScope={dashboardCacheScope}
      projects={projects}
      initialSelectedProjectId={projectSelection.selectedProjectId}
      shouldRepairInitialProjectCookie={projectSelection.shouldRepairCookie}
    >
      <NetworkDebugProvider>
        <DashboardShell flags={flags}>{children}</DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
