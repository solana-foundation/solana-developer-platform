export const PROJECT_COOKIE_NAME = "sdp_selected_project_id";
export const WORKSPACE_SCOPE_COOKIE_NAME = "sdp_workspace_scope";

// Readiness hint only. API authorization remains the source of tenant access.
export function workspaceScope(userId: string, orgId: string, projectId: string): string {
  return `${userId}:${orgId}:${projectId}`;
}
export const PROJECT_HEADER_NAME = "x-project-id";

/**
 * Dashboard-tab scope assertion, set by the Earn data seam on every Earn BFF
 * request: the Dashboard Project the tab RENDERED with. `x-project-id` stays
 * server-owned (resolved from the shared selection cookie); this header is the
 * client's word about which project its React state still shows, so the BFF
 * can refuse a request whose cookie scope another tab has moved on. It is
 * BFF-local and never forwarded upstream.
 */
export const RENDERED_PROJECT_HEADER_NAME = "x-sdp-rendered-project-id";

/**
 * Machine-readable code on the BFF's 409 scope refusal: the declared rendered
 * project no longer matches the cookie-resolved request project. The client's
 * idempotency machinery reads this code to KEEP — never retire — a key the API
 * has not answered for: the refusal happens before the request reaches the
 * API, so nothing was written and nothing was refused by it, and a key
 * retained for an ambiguous earlier attempt must stay claimable for its
 * same-key retry.
 */
export const RENDERED_PROJECT_SCOPE_MISMATCH_ERROR_CODE = "rendered_project_scope_mismatch";

export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 31_536_000,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
};
