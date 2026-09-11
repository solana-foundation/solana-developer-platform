import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";
import {
  PROJECT_COOKIE_NAME,
  WORKSPACE_SCOPE_COOKIE_NAME,
  workspaceScope,
} from "@/lib/project-cookie";
import { WORKSPACE_LOADING_PATH } from "@/lib/workspace-loading";

export const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  WORKSPACE_LOADING_PATH,
  // This polling endpoint performs its own auth check and must return JSON 401,
  // not redirect fetch() to the HTML sign-in page when the session expires.
  "/api/workspace-status",
  "/pay/:token",
  "/",
  "/docs(.*)",
  // Social-card images are fetched by unauthenticated link unfurlers, and the
  // extensionless metadata routes are not excluded by the proxy matcher.
  "/opengraph-image",
  "/twitter-image",
]);

const needsSelectedProject = createRouteMatcher([
  "/dashboard(.*)",
  "/api/dashboard(.*)",
  "/api/playground(.*)",
]);

const isBrowserWriteGated = createRouteMatcher(["/api/dashboard(.*)", "/api/playground(.*)"]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF backstop for the BFF write routes (threat model EARN-021, PRO-1865).
 * The only ambient credential on these routes is the Clerk session cookie, so
 * a write arriving with a cross-origin `Origin` (including the sandboxed
 * literal "null") is never legitimate. A write without an `Origin` header
 * passes unless `Sec-Fetch-Site` positively marks it cross-site: origin-less
 * callers are non-browser clients, which carry no ambient credentials for
 * CSRF to ride on.
 */
export function rejectCrossSiteWrite(req: NextRequest): NextResponse | null {
  if (!WRITE_METHODS.has(req.method) || !isBrowserWriteGated(req)) {
    return null;
  }

  const origin = req.headers.get("origin");
  const crossSite =
    origin !== null
      ? origin !== req.nextUrl.origin
      : ["cross-site", "same-site"].includes(req.headers.get("sec-fetch-site") ?? "");

  if (!crossSite) {
    return null;
  }
  return NextResponse.json({ error: { message: "Cross-origin request refused" } }, { status: 403 });
}

function getUnauthenticatedUrl(req: NextRequest): string {
  const authEntryUrl = new URL(AUTH_ENTRY_PATH, req.url);
  authEntryUrl.searchParams.set("redirect_url", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return authEntryUrl.toString();
}

export const proxy = clerkMiddleware(async (auth, req) => {
  const crossSiteWrite = rejectCrossSiteWrite(req);
  if (crossSiteWrite) {
    return crossSiteWrite;
  }

  if (!isPublicRoute(req)) {
    await auth.protect({
      unauthenticatedUrl: getUnauthenticatedUrl(req),
    });
  }

  if (needsSelectedProject(req)) {
    const { userId, orgId } = await auth();
    const projectId = req.cookies.get(PROJECT_COOKIE_NAME)?.value;
    if (
      userId &&
      orgId &&
      (!projectId ||
        req.cookies.get(WORKSPACE_SCOPE_COOKIE_NAME)?.value !==
          workspaceScope(userId, orgId, projectId))
    ) {
      // Never send a previous organization's project to a dashboard data fetch.
      // Slow webhook polling belongs in the loading page, not Proxy.
      if (req.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: { message: "Workspace is still being prepared" } },
          { status: 425 }
        );
      }
      const loadingUrl = new URL(WORKSPACE_LOADING_PATH, req.url);
      loadingUrl.searchParams.set("return_to", `${req.nextUrl.pathname}${req.nextUrl.search}`);
      return NextResponse.redirect(loadingUrl);
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-sdp-pathname", req.nextUrl.pathname);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  return response;
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
