export const PROJECT_COOKIE_NAME = "sdp_selected_project_id";
export const WORKSPACE_SCOPE_COOKIE_NAME = "sdp_workspace_scope";

// Readiness hint only. API authorization remains the source of tenant access.
export function workspaceScope(userId: string, orgId: string, projectId: string): string {
  return `${userId}:${orgId}:${projectId}`;
}
export const PROJECT_HEADER_NAME = "x-project-id";

/**
 * The proxy's response echo: which project it bound the answer to. Empty
 * list answers carry no rows naming a project, so the echo is what lets a
 * client prove an empty batch really answered for the project it asked for
 * (a proxy that predates the echo says nothing, and is treated accordingly).
 */
export const PROJECT_SCOPE_ECHO_HEADER = "x-sdp-project-id";

export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 31_536_000,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
};
