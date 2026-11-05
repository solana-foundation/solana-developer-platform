import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { DashboardScopeLoadingScreen } from "@/components/dashboard-loading-screen";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getDashboardFlags } from "@/flags/dashboard";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { parseDashboardPathname, projectHref } from "@/lib/dashboard-project-path";
import { resolveProjectFromList } from "@/lib/dashboard-project-selection";
import { PAYMENTS_DEMO_COOKIE_NAME } from "@/lib/payments-demo/demo-cookie";
import { loadQuickStartStatus } from "@/lib/quick-start-server";
import { listSdpProjects, requestMemberRole } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";
import { ProjectOrganizationSwitch } from "./project-organization-switch";

/**
 * Renders the dashboard shell and workspace for a Project-scoped URL, admitting
 * it only when its Project is one the session's organization lists. For any
 * other Project id the URL decides the organization: the browser makes active
 * the user's organization that lists it, or, when none does, goes to the session
 * organization's Sandbox Project, keeping the page it asked for (HOO-2622).
 * Project-less URLs never get here: proxy.ts sends them to the bare `/dashboard`
 * landing. This is navigation only: sdp-api authorizes every request on its own.
 *
 * @param props.children - The Project-scoped page.
 * @param props.params - Route params carrying the URL's Project id.
 * @returns The page inside the dashboard shell, or the organization switch for an unlisted Project.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }, projects, { orgId, userId }, flags, cookieStore, initialQuickStartStatus] =
    await Promise.all([
      params,
      listSdpProjects(),
      getSdpAuth(),
      getDashboardFlags(),
      cookies(),
      loadQuickStartStatus(),
    ]);
  if (!orgId || !userId) {
    throw new Error("The dashboard layout admits only signed-in members of an organization");
  }
  if (projects.some((project) => project.id === projectId)) {
    const dashboardCacheScope = { orgId, userId } satisfies DashboardCacheScope;
    const dashboardAccess = resolveDashboardAccess(await requestMemberRole());
    return (
      <DashboardWorkspaceProvider
        key={getDashboardCacheScopeKey(dashboardCacheScope)}
        scopeRefreshFallback={<DashboardScopeLoadingScreen />}
        dashboardAccess={dashboardAccess}
        initialQuickStartStatus={initialQuickStartStatus}
        flags={flags}
        serverDashboardCacheScope={dashboardCacheScope}
        projects={projects}
      >
        <NetworkDebugProvider>
          <DashboardShell
            flags={flags}
            paymentsDemo={{
              demoProjectId: cookieStore.get(PAYMENTS_DEMO_COOKIE_NAME)?.value ?? null,
            }}
          >
            {children}
          </DashboardShell>
        </NetworkDebugProvider>
      </DashboardWorkspaceProvider>
    );
  }

  const pathname = (await headers()).get("x-sdp-pathname");
  if (pathname === null) {
    throw new Error("x-sdp-pathname is set by proxy.ts on every dashboard request");
  }
  const dashboardPath = parseDashboardPathname(pathname).dashboardPath;
  const sandboxProject = resolveProjectFromList(projects, null);
  return (
    <ProjectOrganizationSwitch
      projectId={projectId}
      sessionOrganizationId={orgId}
      fallbackHref={
        sandboxProject === null
          ? WORKSPACE_LOADING_PATH
          : projectHref(sandboxProject.id, dashboardPath)
      }
      flags={flags}
    />
  );
}
