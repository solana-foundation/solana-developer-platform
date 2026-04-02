import { clerkSignInEntry, clerkSignUpEntry } from "@/flags";

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export async function isSignInEntryEnabled(): Promise<boolean> {
  return clerkSignInEntry();
}

export async function isSignUpEntryEnabled(): Promise<boolean> {
  return clerkSignUpEntry();
}

export async function isAnyAuthEntryEnabled(): Promise<boolean> {
  const [signInEnabled, signUpEnabled] = await Promise.all([
    isSignInEntryEnabled(),
    isSignUpEntryEnabled(),
  ]);

  return signInEnabled || signUpEnabled;
}

export async function getAuthEntryPath(): Promise<string> {
  if (await isSignInEntryEnabled()) {
    return "/sign-in";
  }

  if (await isSignUpEntryEnabled()) {
    return "/sign-up";
  }

  return "/";
}

export async function shouldLoadClerkForPath(pathname: string): Promise<boolean> {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/allowlist" ||
    pathname.startsWith("/allowlist/") ||
    pathname === "/members" ||
    pathname.startsWith("/members/") ||
    (pathname === "/" && (await isAnyAuthEntryEnabled())) ||
    (matchesRoute(pathname, "/sign-in") && (await isSignInEntryEnabled())) ||
    (matchesRoute(pathname, "/sign-up") && (await isSignUpEntryEnabled()))
  );
}
