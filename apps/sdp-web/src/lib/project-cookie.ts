export const PROJECT_COOKIE_NAME = "sdp_selected_project_id";
export const WORKSPACE_SCOPE_COOKIE_NAME = "sdp_workspace_scope";

// Readiness hint only. API authorization remains the source of tenant access.
export function workspaceScope(userId: string, orgId: string, projectId: string): string {
  return `${userId}:${orgId}:${projectId}`;
}
export const PROJECT_HEADER_NAME = "x-project-id";

/**
 * Inbound header a dashboard client sends to the BFF routes naming the project
 * context its mounted surface was rendered with. Unlike the shared selection
 * cookie, it cannot be flipped by a sibling tab between render and submit, so
 * issuance reads and mutations stay bound to the reviewed project.
 */
export const PROJECT_CONTEXT_HEADER_NAME = "x-sdp-project-context";

export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 31_536_000,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
};
