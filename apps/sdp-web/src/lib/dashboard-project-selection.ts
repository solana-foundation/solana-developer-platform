import type { Project } from "@sdp/types";

export const DEFAULT_SANDBOX_PROJECT_SLUG = "default-sandbox";

type ProjectLike = Pick<Project, "id" | "slug">;

interface ResolveProjectFromListOptions {
  /**
   * Take the first listed project when the organization has no sandbox. The
   * cookie-writing action and the readiness probe opt in because a written
   * cookie or a "ready" verdict needs SOME project; the layout and the
   * request-scoped API client leave it off so a missing sandbox never selects
   * production on the customer's behalf.
   */
  fallbackToFirstProject?: boolean;
}

/**
 * The one project fallback chain, shared by the dashboard layout, the
 * cookie-repairing server action, the workspace readiness probe and the
 * request-scoped API client: the cookie's project while the organization still
 * lists it, else the default sandbox, else (opt-in) the first project.
 *
 * A cookie can name a project outside the list when two local stacks share
 * `localhost` cookies, and in production when a project is archived or the
 * membership is revoked. Every consumer must agree on the answer, or the shell
 * shows one project while the pages read another.
 */
export function resolveProjectFromList<TProject extends ProjectLike>(
  projects: readonly TProject[],
  cookieProjectId: string | null | undefined,
  { fallbackToFirstProject = false }: ResolveProjectFromListOptions = {}
): TProject | null {
  const cookieProject = cookieProjectId
    ? projects.find((project) => project.id === cookieProjectId)
    : undefined;
  return (
    cookieProject ??
    projects.find((project) => project.slug === DEFAULT_SANDBOX_PROJECT_SLUG) ??
    (fallbackToFirstProject ? projects[0] : undefined) ??
    null
  );
}

export interface DashboardProjectSelection {
  selectedProjectId: string | null;
  shouldRepairCookie: boolean;
}

interface DashboardProjectSelectionOptions {
  projectListIsAuthoritative: boolean;
}

/**
 * Resolves the selected dashboard project without mutating request state.
 * Missing cookies use the sandbox in memory (the proxy normally bootstraps
 * them); stale cookies are explicitly flagged for client-side repair.
 */
export function resolveDashboardProjectSelection(
  projects: Project[],
  cookieProjectId: string | null | undefined,
  { projectListIsAuthoritative }: DashboardProjectSelectionOptions
): DashboardProjectSelection {
  const selectedProject = resolveProjectFromList(projects, cookieProjectId);

  return {
    selectedProjectId: selectedProject?.id ?? null,
    shouldRepairCookie:
      projectListIsAuthoritative &&
      Boolean(cookieProjectId) &&
      selectedProject?.id !== cookieProjectId,
  };
}
