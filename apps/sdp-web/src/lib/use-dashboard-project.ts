"use client";

import { useParams, usePathname } from "next/navigation";
import { parseDashboardPathname, projectHref } from "./dashboard-project-path";

/**
 * The Project the current page is scoped to, read from its URL. For components
 * that only render under `/dashboard/[projectId]`.
 *
 * @returns The URL's Project id.
 */
export function useProjectId(): string {
  const { projectId } = useParams<{ projectId?: string }>();
  if (projectId === undefined) {
    throw new Error("useProjectId must be used under /dashboard/[projectId]");
  }
  return projectId;
}

/**
 * The current pathname without its Project segment, so route tables and
 * active-link checks keep comparing against `/dashboard/<page>` paths.
 *
 * @returns The project-less dashboard path of the current page.
 */
export function useDashboardPathname(): string {
  return parseDashboardPathname(usePathname()).dashboardPath;
}

/**
 * Link builder bound to the current URL's Project, so callers write project-less
 * dashboard paths and never handle the Project themselves.
 *
 * @returns A function mapping a project-less dashboard path to its href in this Project.
 */
export function useProjectHref(): (dashboardPath: string) => string {
  const projectId = useProjectId();
  return (dashboardPath) => projectHref(projectId, dashboardPath);
}
