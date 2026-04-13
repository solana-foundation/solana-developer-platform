export const AUTH_ENTRY_PATH = "/sign-in";

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export async function getAuthEntryPath(): Promise<string> {
  return AUTH_ENTRY_PATH;
}

export async function shouldLoadClerkForPath(pathname: string): Promise<boolean> {
  return (
    pathname === "/" ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/allowlist" ||
    pathname.startsWith("/allowlist/") ||
    pathname === "/members" ||
    pathname.startsWith("/members/") ||
    matchesRoute(pathname, "/sign-in") ||
    matchesRoute(pathname, "/sign-up")
  );
}
