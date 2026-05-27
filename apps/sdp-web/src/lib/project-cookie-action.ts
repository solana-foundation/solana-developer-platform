"use server";

import type { ListProjectsResponse } from "@sdp/types";
import { cookies } from "next/headers";
import { PROJECT_COOKIE_NAME, PROJECT_COOKIE_OPTIONS } from "./project-cookie";
import { sdpApiFetch } from "./sdp-api";

export async function selectProjectAction(projectId: string | null): Promise<void> {
  const store = await cookies();
  if (projectId) {
    store.set(PROJECT_COOKIE_NAME, projectId, PROJECT_COOKIE_OPTIONS);
  } else {
    store.delete(PROJECT_COOKIE_NAME);
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
  let projects: ListProjectsResponse["projects"] = [];
  try {
    projects = (await sdpApiFetch<ListProjectsResponse>("/v1/projects")).projects;
  } catch {
    return false;
  }

  const store = await cookies();
  const current = store.get(PROJECT_COOKIE_NAME)?.value ?? null;
  if (current && projects.some((p) => p.id === current)) return true;

  const next = projects.find((p) => p.slug === "default-sandbox") ?? projects[0] ?? null;
  if (next) {
    store.set(PROJECT_COOKIE_NAME, next.id, PROJECT_COOKIE_OPTIONS);
  } else if (current) {
    store.delete(PROJECT_COOKIE_NAME);
  }
  return true;
}
