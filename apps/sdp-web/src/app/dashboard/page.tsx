import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseDashboardPathname, projectHref } from "@/lib/dashboard-project-path";
import { resolveProjectFromList } from "@/lib/dashboard-project-selection";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { listSdpProjects } from "@/lib/sdp-api";
import { normalizeWorkspaceReturnPath, WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

/**
 * Bare `/dashboard` renders nothing: it lands on the last-used Project while the
 * user can still reach it, else the Organization's Sandbox Project, at the page
 * `return_to` names (proxy.ts sends project-less page URLs here) or the Project's
 * home. An Organization whose Projects are still being provisioned waits on the
 * workspace loading page, which returns here once they exist.
 *
 * @param props.searchParams - The landing's query; `return_to` is a project-less dashboard path.
 * @returns Never; always redirects.
 */
export default async function DashboardLandingPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string | string[] }>;
}): Promise<never> {
  const [{ return_to: returnTo }, projects, cookieStore] = await Promise.all([
    searchParams,
    listSdpProjects(),
    cookies(),
  ]);
  const returnPath = normalizeWorkspaceReturnPath(returnTo);
  const project = resolveProjectFromList(projects, cookieStore.get(PROJECT_COOKIE_NAME)?.value);
  if (project === null) {
    redirect(`${WORKSPACE_LOADING_PATH}?return_to=${encodeURIComponent(returnPath)}`);
  }
  const returnUrl = new URL(returnPath, "https://dashboard.local");
  redirect(
    projectHref(
      project.id,
      `${parseDashboardPathname(returnUrl.pathname).dashboardPath}${returnUrl.search}${returnUrl.hash}`
    )
  );
}
