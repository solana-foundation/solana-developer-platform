export const PROJECT_COOKIE_NAME = "sdp_selected_project_id";
export const WORKSPACE_SCOPE_COOKIE_NAME = "sdp_workspace_scope";

// Readiness hint only. API authorization remains the source of tenant access.
export function workspaceScope(userId: string, orgId: string, projectId: string): string {
  return `${userId}:${orgId}:${projectId}`;
}
export const PROJECT_HEADER_NAME = "x-project-id";

/**
 * Header carrying the sealed render scope (see `lib/render-scope`) from a
 * dashboard form to the BFF routes that must stay bound to the project the
 * page was rendered with. Isomorphic: the workspace sends the name, the BFF
 * route reads the value.
 */
export const RENDER_SCOPE_HEADER_NAME = "x-sdp-render-scope";

export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 31_536_000,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
};
