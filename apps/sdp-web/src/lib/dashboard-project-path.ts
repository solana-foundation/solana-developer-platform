const DASHBOARD_PREFIX = "/dashboard";
const PROJECT_ID_PREFIX = "prj_";

/**
 * Whether a dashboard path segment is a Project id rather than a page name.
 * Project ids are minted by sdp-api as `prj_<uuid>`; no dashboard page segment
 * starts with that prefix, which is what lets a project-less path
 * (`/dashboard/payments`) be told apart from a project-scoped one.
 *
 * @param segment - First path segment after `/dashboard`.
 * @returns True when the segment has the Project id shape.
 */
export function isProjectIdSegment(segment: string): boolean {
  return segment.startsWith(PROJECT_ID_PREFIX);
}

/**
 * Splits a pathname into the Project it is scoped to and the project-less
 * dashboard path every route table and pathname comparison is written against.
 *
 * @param pathname - Browser or request pathname.
 * @returns `projectId` (null outside a Project-scoped URL) and `dashboardPath`,
 *   e.g. `/dashboard/prj_1/payments` → `{ projectId: "prj_1", dashboardPath: "/dashboard/payments" }`.
 */
export function parseDashboardPathname(pathname: string): {
  projectId: string | null;
  dashboardPath: string;
} {
  if (pathname !== DASHBOARD_PREFIX && !pathname.startsWith(`${DASHBOARD_PREFIX}/`)) {
    return { projectId: null, dashboardPath: pathname };
  }
  const rest = pathname.slice(DASHBOARD_PREFIX.length + 1);
  const slashIndex = rest.indexOf("/");
  const segment = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  if (!isProjectIdSegment(segment)) {
    return { projectId: null, dashboardPath: pathname };
  }
  return {
    projectId: segment,
    dashboardPath:
      slashIndex === -1 ? DASHBOARD_PREFIX : `${DASHBOARD_PREFIX}${rest.slice(slashIndex)}`,
  };
}

/**
 * Builds the Project-scoped URL for a project-less dashboard path.
 *
 * @param projectId - Project the link must stay inside.
 * @param dashboardPath - Path as the route tables spell it, starting with `/dashboard`
 *   (query and hash allowed).
 * @returns `/dashboard/<projectId>` followed by the rest of `dashboardPath`.
 */
export function projectHref(projectId: string, dashboardPath: string): string {
  if (dashboardPath !== DASHBOARD_PREFIX && !/^\/dashboard[/?#]/.test(dashboardPath)) {
    throw new Error(`Not a dashboard path: ${dashboardPath}`);
  }
  return `${DASHBOARD_PREFIX}/${projectId}${dashboardPath.slice(DASHBOARD_PREFIX.length)}`;
}
