import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { parseDashboardPathname, projectHref } from "@/lib/dashboard-project-path";
import { resolveProjectFromList } from "@/lib/dashboard-project-selection";
import { listSdpProjects } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

/**
 * Admits a Project-scoped URL only when its Project is one this user can list;
 * a Project id the user cannot reach goes to the Sandbox Project, keeping the
 * page it asked for. Project-less URLs never get here: proxy.ts sends
 * them to the bare `/dashboard` landing. This is navigation only: sdp-api
 * authorizes every request on its own.
 *
 * @param props.children - The Project-scoped page.
 * @param props.params - Route params carrying the URL's Project id.
 * @returns The page, or a redirect.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }, projects] = await Promise.all([params, listSdpProjects()]);
  if (projects.some((project) => project.id === projectId)) {
    return children;
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
