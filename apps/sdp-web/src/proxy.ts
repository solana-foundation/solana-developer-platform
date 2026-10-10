import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";
import { parseDashboardPathname } from "@/lib/dashboard-project-path";
import { isDemoSessionCookie } from "@/lib/payments-demo/demo-cookie";
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
  // Social-card images are fetched by unauthenticated link unfurlers, and the
  // extensionless metadata routes are not excluded by the proxy matcher.
  "/opengraph-image",
  "/twitter-image",
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

/**
 * The demo session's cookies to forget on this request: all of them on a full page load (a
 * refresh, a new tab, the demo switched on or off), none on the app's own navigations and
 * fetches. Demo changes live for one page load, as a browser tab's memory would.
 */
export function demoSessionCookiesToDrop(req: NextRequest): string[] {
  if (req.headers.get("sec-fetch-dest") !== "document") {
    return [];
  }
  return req.cookies
    .getAll()
    .map((cookie) => cookie.name)
    .filter(isDemoSessionCookie);
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

  // A project-less page URL (old bookmarks, emailed links) matches no route under
  // `[projectId]` once it is nested, so it is resolved before routing: the bare
  // landing picks the Project and returns to the same page and query inside it.
  const { projectId } = parseDashboardPathname(req.nextUrl.pathname);
  if (projectId === null && /^\/dashboard\/[^/]/.test(req.nextUrl.pathname)) {
    const landingUrl = new URL("/dashboard", req.url);
    landingUrl.searchParams.set("return_to", `${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(landingUrl);
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-sdp-pathname", req.nextUrl.pathname);
  const droppedDemoCookies = demoSessionCookiesToDrop(req);
  if (droppedDemoCookies.length > 0) {
    // Filter the raw header, so every other cookie reaches the page byte for byte.
    const kept = (req.headers.get("cookie") ?? "")
      .split(";")
      .filter((pair) => !isDemoSessionCookie(pair.split("=", 1)[0]?.trim() ?? ""));
    requestHeaders.set("cookie", kept.join(";").trim());
  }

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

  for (const name of droppedDemoCookies) {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  }

  // Last-used hint for the bare `/dashboard` landing only; nothing renders or
  // sends requests from it, and it is validated against the Project list when read.
  if (projectId !== null) {
    response.cookies.set(PROJECT_COOKIE_NAME, projectId, PROJECT_COOKIE_OPTIONS);
  }
  return response;
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
