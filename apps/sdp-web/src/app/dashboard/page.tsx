import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";
import { resolveProjectFromList } from "@/lib/dashboard-project-selection";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { listSdpProjects } from "@/lib/sdp-api";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

/**
 * Bare `/dashboard` renders nothing: it lands on the last-used Project while the
 * user can still reach it, else the Organization's Sandbox Project. An
 * Organization whose Projects are still being provisioned waits on the
 * workspace loading page, which returns here once they exist.
 */
export default async function DashboardLandingPage(): Promise<never> {
  const [projects, cookieStore] = await Promise.all([listSdpProjects(), cookies()]);
  const project = resolveProjectFromList(projects, cookieStore.get(PROJECT_COOKIE_NAME)?.value);
  if (project === null) {
    redirect(`${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent("/dashboard")}`);
  }
  redirect(projectHref(project.id, "/dashboard"));
}
