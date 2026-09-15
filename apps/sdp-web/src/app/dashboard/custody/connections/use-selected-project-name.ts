"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/**
 * The selected project's display name, for the copy that has to say which
 * project a connection or a default belongs to.
 *
 * Read from the workspace the shell already resolved rather than fetched
 * again: the project switcher is the authority on what "this project" means,
 * and a second read could disagree with the header the user is looking at.
 *
 * Falls back to an empty string while the selection is still unresolved; every
 * caller interpolates it into a sentence that stays grammatical without it.
 */
export function useSelectedProjectName(): string {
  const { projects, selectedProjectId } = useDashboardWorkspace();
  return projects.find((project) => project.id === selectedProjectId)?.name ?? "";
}
