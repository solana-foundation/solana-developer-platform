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
 * The Project in the current URL, or null on Organization-level pages
 * (settings, members) that render outside any Project.
 *
 * @returns The URL's Project id, or null outside a Project-scoped URL.
 */
export function useOptionalProjectId(): string | null {
  const { projectId } = useParams<{ projectId?: string }>();
  return projectId === undefined ? null : projectId;
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
 * Link builder bound to the current URL's Project. On Organization-level pages
 * there is no Project, so links stay project-less and the `[projectId]` layout
 * resolves them to the last-used or Sandbox Project on arrival.
 *
 * @returns A function mapping a project-less dashboard path to the href to render.
 */
export function useProjectHref(): (dashboardPath: string) => string {
  const projectId = useOptionalProjectId();
  return (dashboardPath) =>
    projectId === null ? dashboardPath : projectHref(projectId, dashboardPath);
}
