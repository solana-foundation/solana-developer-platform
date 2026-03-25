import { clerkAuthEntry } from "@/flags";

export async function isAuthEntryEnabled(): Promise<boolean> {
  return clerkAuthEntry();
}

export async function getAuthEntryPath(): Promise<string> {
  return (await isAuthEntryEnabled()) ? "/sign-in" : "/";
}

export async function shouldLoadClerkForPath(pathname: string): Promise<boolean> {
  if (await isAuthEntryEnabled()) {
    return true;
  }

  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/allowlist" ||
    pathname.startsWith("/allowlist/") ||
    pathname === "/members" ||
    pathname.startsWith("/members/")
  );
}
