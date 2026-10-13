import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
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
import { loadQuickStartStep } from "@/lib/quick-start-server";
import { getSdpAuth, listSdpProjects } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

/**
 * Renders the dashboard shell and workspace for a Project-scoped URL, admitting
 * it only when its Project is one this user can list;
 * a Project id the user cannot reach goes to the Sandbox Project, keeping the
 * page it asked for. Project-less URLs never get here: proxy.ts sends
 * them to the bare `/dashboard` landing. This is navigation only: sdp-api
 * authorizes every request on its own.
 *
 * @param props.children - The Project-scoped page.
 * @param props.params - Route params carrying the URL's Project id.
 * @returns The page inside the dashboard shell, or a redirect.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const [
    { projectId },
    projects,
    { orgRole, orgId, userId },
    flags,
    initialQuickStartStep,
    cookieStore,
  ] = await Promise.all([
    params,
    listSdpProjects(),
    getSdpAuth(),
    getDashboardFlags(),
    loadQuickStartStep(),
    cookies(),
  ]);
  if (projects.some((project) => project.id === projectId)) {
    if (!orgId || !userId) {
      throw new Error("The dashboard layout admits only signed-in members of an organization");
    }
    const dashboardCacheScope = { orgId, userId } satisfies DashboardCacheScope;
    return (
      <DashboardWorkspaceProvider
        key={getDashboardCacheScopeKey(dashboardCacheScope)}
        scopeRefreshFallback={<DashboardScopeLoadingScreen />}
        dashboardAccess={resolveDashboardAccess(orgRole)}
        initialQuickStartStep={initialQuickStartStep}
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
  const sandboxProject = resolveProjectFromList(projects, null);
  if (sandboxProject === null) {
    redirect(`${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent("/dashboard")}`);
  }
  redirect(projectHref(sandboxProject.id, parseDashboardPathname(pathname).dashboardPath));
}
