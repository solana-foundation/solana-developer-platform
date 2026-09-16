"use server";

import type { ListProjectsResponse } from "@sdp/types";
import { cookies } from "next/headers";
import { retryProjectBootstrap } from "./project-bootstrap-retry";
import {
  PROJECT_COOKIE_NAME,
  PROJECT_COOKIE_OPTIONS,
  WORKSPACE_SCOPE_COOKIE_NAME,
  workspaceScope,
} from "./project-cookie";
import { createOrgSdpApiClient, getSdpAuth } from "./sdp-api";

export async function selectProjectAction(projectId: string | null): Promise<void> {
  const store = await cookies();
  if (projectId) {
    const { userId, orgId } = await getSdpAuth();
    const client = await createOrgSdpApiClient();
    const { projects } = await client.fetch<ListProjectsResponse>("/v1/projects");
    if (!userId || !orgId || !projects.some((project) => project.id === projectId)) {
      throw new Error("Project is not available in this organization");
    }
    store.set(PROJECT_COOKIE_NAME, projectId, PROJECT_COOKIE_OPTIONS);
    store.set(
      WORKSPACE_SCOPE_COOKIE_NAME,
      workspaceScope(userId, orgId, projectId),
      PROJECT_COOKIE_OPTIONS
    );
  } else {
    store.delete(PROJECT_COOKIE_NAME);
    store.delete(WORKSPACE_SCOPE_COOKIE_NAME);
  }
}

/**
 * Called on Clerk org switch. Loads the new org's projects under the new
 * session and, if the cookie's projectId isn't accessible in that scope,
 * replaces it with the new org's sandbox. Setting the cookie inside a Server
 * Action triggers Next to re-render the current page/layouts with the new
 * value in effect — SSR never runs with a stale cookie.
 *
 * Returns `true` if the fetch succeeded (cookie may or may not have been
 * mutated), or `false` if the API call threw. Callers should fall back to
 * `router.refresh()` on `false` so the page doesn't keep rendering the
 * previous org's server-component output.
 */
export async function reconcileProjectCookieAction(): Promise<boolean> {
  let projects: ListProjectsResponse["projects"] | null;
  try {
    projects = await retryProjectBootstrap({
      load: async () => {
        const client = await createOrgSdpApiClient();
        return (await client.fetch<ListProjectsResponse>("/v1/projects")).projects;
      },
      isReady: (value) => value.length > 0,
    });
  } catch {
    return false;
  }
  if (!projects) return false;

  const store = await cookies();
  const current = store.get(PROJECT_COOKIE_NAME)?.value ?? null;
  const next =
    projects.find((p) => p.id === current) ??
    projects.find((p) => p.slug === "default-sandbox") ??
    projects[0] ??
    null;
  if (next) {
    const { userId, orgId } = await getSdpAuth();
    if (!userId || !orgId) return false;
    store.set(PROJECT_COOKIE_NAME, next.id, PROJECT_COOKIE_OPTIONS);
    store.set(
      WORKSPACE_SCOPE_COOKIE_NAME,
      workspaceScope(userId, orgId, next.id),
      PROJECT_COOKIE_OPTIONS
    );
  } else if (current) {
    store.delete(PROJECT_COOKIE_NAME);
  }
  return true;
}
