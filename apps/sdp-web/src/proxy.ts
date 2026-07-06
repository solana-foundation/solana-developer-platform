import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { ListProjectsResponse } from "@sdp/types";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";
import { PROJECT_COOKIE_NAME, PROJECT_COOKIE_OPTIONS } from "@/lib/project-cookie";
import { acquireClerkToken, createTokenSdpApiClient } from "@/lib/sdp-api";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/", "/docs(.*)"]);

const needsSelectedProject = createRouteMatcher([
  "/dashboard(.*)",
  "/api/dashboard(.*)",
  "/api/playground(.*)",
]);

function getUnauthenticatedUrl(req: NextRequest): string {
  const authEntryUrl = new URL(AUTH_ENTRY_PATH, req.url);
  authEntryUrl.searchParams.set("redirect_url", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return authEntryUrl.toString();
}

/**
 * Resolves the org's default project (sandbox, else first) so a fresh session
 * enters the dashboard with the project cookie already in place — before any
 * page SSR or dashboard API route runs. Returns null when the org has no
 * projects or the lookup fails; the request then proceeds cookieless and the
 * existing route-level "Selected project required" handling surfaces the
 * failure instead of the proxy taking down every dashboard request.
 *
 * The "default-sandbox" slug is safe to hardcode: sdp-api's project
 * provisioning (project.service.ts) assigns exactly that slug to every org's
 * auto-created sandbox project and slugs aren't user-editable, so it's a
 * platform invariant — the same discriminator DashboardWorkspaceProvider and
 * reconcileProjectCookieAction already match on.
 */
async function resolveDefaultProjectId(
  getToken: (options?: { template?: string }) => Promise<string | null>
): Promise<string | null> {
  try {
    const client = createTokenSdpApiClient(await acquireClerkToken(getToken));
    const { projects } = await client.fetch<ListProjectsResponse>("/v1/projects");
    return (
      (projects.find((project) => project.slug === "default-sandbox") ?? projects[0])?.id ?? null
    );
  } catch {
    return null;
  }
}

export const proxy = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect({
      unauthenticatedUrl: getUnauthenticatedUrl(req),
    });
  }

  let bootstrappedProjectId: string | null = null;
  if (needsSelectedProject(req) && !req.cookies.has(PROJECT_COOKIE_NAME)) {
    const { getToken, orgId } = await auth();
    if (orgId) {
      bootstrappedProjectId = await resolveDefaultProjectId(getToken);
      if (bootstrappedProjectId) {
        req.cookies.set(PROJECT_COOKIE_NAME, bootstrappedProjectId);
      }
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-sdp-pathname", req.nextUrl.pathname);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  if (bootstrappedProjectId) {
    response.cookies.set(PROJECT_COOKIE_NAME, bootstrappedProjectId, PROJECT_COOKIE_OPTIONS);
  }
  return response;
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
