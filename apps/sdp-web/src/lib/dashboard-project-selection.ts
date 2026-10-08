import type { Project } from "@sdp/types";

export const DEFAULT_SANDBOX_PROJECT_SLUG = "default-sandbox";

type ProjectLike = Pick<Project, "id" | "slug">;

/**
 * The Project a dashboard landing resolves to: the last-used Project while the
 * Organization still lists it, else the default Sandbox. A missing Sandbox
 * never selects Production on the customer's behalf.
 *
 * @param projects - The user's Project list for the active Organization.
 * @param lastUsedProjectId - The last-used hint from the selection cookie.
 * @returns The Project to land on, or null while none is provisioned.
 */
export function resolveProjectFromList<TProject extends ProjectLike>(
  projects: readonly TProject[],
  lastUsedProjectId: string | null | undefined
): TProject | null {
  const lastUsedProject = projects.find((project) => project.id === lastUsedProjectId);
  if (lastUsedProject !== undefined) {
    return lastUsedProject;
  }
  const sandboxProject = projects.find((project) => project.slug === DEFAULT_SANDBOX_PROJECT_SLUG);
  return sandboxProject === undefined ? null : sandboxProject;
}
