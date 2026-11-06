import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { SDP_TERMS_PATH } from "@sdp/types/site";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SIGN_IN_PATH, SIGN_UP_PATH, signInHref } from "@/lib/clerk-config";
import { parseDashboardPathname } from "@/lib/dashboard-project-path";
import {
  PROJECT_COOKIE_NAME,
  PROJECT_COOKIE_OPTIONS,
  PROJECT_HEADER_NAME,
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
  SDP_TERMS_PATH,
  // Social-card images are fetched by unauthenticated link unfurlers, and the
  // extensionless metadata routes are not excluded by the proxy matcher.
  "/opengraph-image",
  "/twitter-image",
]);

const isBrowserWriteGated = createRouteMatcher(["/api/dashboard(.*)", "/api/playground(.*)"]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF backstop for the BFF write routes and every Server Action (threat model
 * EARN-021, PRO-1865): an action posts to the page's own URL with a
 * `Next-Action` header, so it is gated by that header rather than by path.
 * The only ambient credential on these requests is the Clerk session cookie, so
 * a write arriving with a cross-origin `Origin` (including the sandboxed
 * literal "null") is never legitimate. A write without an `Origin` header
 * passes unless `Sec-Fetch-Site` marks it cross-site, or, with neither header,
 * it carries the Clerk session cookie.
 */
export function rejectCrossSiteWrite(req: NextRequest): NextResponse | null {
  if (
    !WRITE_METHODS.has(req.method) ||
    !(isBrowserWriteGated(req) || req.headers.has("next-action"))
  ) {
    return null;
  }

  if (!isCrossSiteWrite(req)) {
    return null;
  }
  return NextResponse.json({ error: { message: "Cross-origin request refused" } }, { status: 403 });
}

/**
 * Whether a write may come from another site. Without an `Origin`, the fetch
 * site decides; with neither header the request cannot be placed, so it is
 * refused while it carries the Clerk session cookie, the only credential CSRF
 * could ride on.
 *
 * @param req - The write.
 * @returns True when the write must be refused.
 */
function isCrossSiteWrite(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    return origin !== req.nextUrl.origin;
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === null) {
    // Clerk also signs in from a suffixed `__session_<suffix>` cookie.
    return req.cookies.getAll().some((cookie) => cookie.name.startsWith("__session"));
  }
  return ["cross-site", "same-site"].includes(fetchSite);
}

function getUnauthenticatedUrl(req: NextRequest): string {
  return new URL(signInHref(`${req.nextUrl.pathname}${req.nextUrl.search}`), req.url).toString();
}

export const proxy = clerkMiddleware(
  async (auth, req) => {
    const crossSiteWrite = rejectCrossSiteWrite(req);
    if (crossSiteWrite) {
      return crossSiteWrite;
    }

    if (!isPublicRoute(req)) {
      await auth.protect({
        unauthenticatedUrl: getUnauthenticatedUrl(req),
      });
    }

    const { projectId } = parseDashboardPathname(req.nextUrl.pathname);
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-sdp-pathname", req.nextUrl.pathname);

    // The request's Project is the one its tab renders: page renders and server
    // actions (Next posts actions to the tab's URL) take it from this URL, browser
    // calls to /api/* send it themselves (dashboardRequest). Server code reads only
    // this header, through createSdpApiClient (HOO-1965).
    if (!req.nextUrl.pathname.startsWith("/api/")) {
      if (projectId === null) {
        requestHeaders.delete(PROJECT_HEADER_NAME);
      } else {
        requestHeaders.set(PROJECT_HEADER_NAME, projectId);
      }
    }

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    if (
      (req.nextUrl.pathname === SIGN_IN_PATH ||
        req.nextUrl.pathname.startsWith(`${SIGN_IN_PATH}/`)) &&
      !(await auth()).userId
    ) {
      response.cookies.set(PROJECT_COOKIE_NAME, "", { ...PROJECT_COOKIE_OPTIONS, maxAge: 0 });
    }

    // Last-used hint for the bare `/dashboard` landing only; nothing renders or
    // sends requests from it, and it is validated against the Project list when read.
    if (projectId !== null) {
      response.cookies.set(PROJECT_COOKIE_NAME, projectId, PROJECT_COOKIE_OPTIONS);
    }
    return response;
  },
  { signInUrl: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH }
);

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
