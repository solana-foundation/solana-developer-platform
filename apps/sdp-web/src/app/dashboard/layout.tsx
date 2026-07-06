import { auth } from "@clerk/nextjs/server";
import type { ListProjectsResponse, Project } from "@sdp/types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

async function loadProjects(): Promise<Project[]> {
  try {
    const client = await createOrgSdpApiClient();
    const response = await client.fetch<ListProjectsResponse>("/v1/projects");
    return response.projects;
  } catch {
    return [];
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgRole, orgId, userId } = await auth();

  if (!userId || !orgId) {
    redirect(await getAuthEntryPath());
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const dashboardCacheScope = {
    orgId,
    userId,
  } satisfies DashboardCacheScope;

  const projects = await loadProjects();
  const cookieStore = await cookies();
  const cookieProjectId = cookieStore.get(PROJECT_COOKIE_NAME)?.value ?? null;
  const initialSelectedProjectId =
    cookieProjectId && projects.some((project) => project.id === cookieProjectId)
      ? cookieProjectId
      : null;

  return (
    <DashboardWorkspaceProvider
      key={getDashboardCacheScopeKey(dashboardCacheScope)}
      dashboardAccess={dashboardAccess}
      serverDashboardCacheScope={dashboardCacheScope}
      projects={projects}
      initialSelectedProjectId={initialSelectedProjectId}
    >
      <NetworkDebugProvider>
        <DashboardShell>{children}</DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
