import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  isProjectIdSegment,
  parseDashboardPathname,
  projectHref,
} from "@/lib/dashboard-project-path";
import { resolveProjectFromList } from "@/lib/dashboard-project-selection";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { listSdpProjects } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

/**
 * Admits a Project-scoped URL only when its Project is one this user can list.
 * Two kinds of URL are redirected instead, keeping the page they asked for:
 * a project-less path (`/dashboard/payments`, whose first segment lands here as
 * `projectId`) goes to the last-used or Sandbox Project, and a Project
 * id the user cannot reach goes to the Sandbox Project. This is navigation only:
 * sdp-api authorizes every request on its own.
 *
 * @param props.children - The Project-scoped page.
 * @param props.params - Route params carrying the URL's first dashboard segment.
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
  const projectlessPath = !isProjectIdSegment(projectId);
  const target = resolveProjectFromList(
    projects,
    projectlessPath ? (await cookies()).get(PROJECT_COOKIE_NAME)?.value : null
  );
  if (target === null) {
    redirect(`${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent("/dashboard")}`);
  }
  redirect(
    projectHref(
      target.id,
      projectlessPath ? pathname : parseDashboardPathname(pathname).dashboardPath
    )
  );
}
