import type { Project } from "@sdp/types";

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
  const cookieProject = cookieProjectId
    ? projects.find((project) => project.id === cookieProjectId)
    : undefined;
  const fallbackProject = projects.find((project) => project.slug === "default-sandbox") ?? null;

  return {
    selectedProjectId: cookieProject?.id ?? fallbackProject?.id ?? null,
    shouldRepairCookie: projectListIsAuthoritative && Boolean(cookieProjectId && !cookieProject),
  };
}
