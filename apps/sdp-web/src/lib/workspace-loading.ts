export const WORKSPACE_LOADING_PATH = "/workspace-loading";
export const WORKSPACE_LOADING_RETRY_MS = 1500;

export function normalizeWorkspaceReturnPath(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) {
    return "/dashboard";
  }

  const destination = new URL(candidate, "https://dashboard.local");
  if (destination.pathname !== "/dashboard" && !destination.pathname.startsWith("/dashboard/")) {
    return "/dashboard";
  }

  return `${destination.pathname}${destination.search}${destination.hash}`;
}
