import { getDefaultAuthEntryPath } from "@/lib/auth-entry-config";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/", "/docs(.*)"]);

function getUnauthenticatedUrl(req: NextRequest): string {
  // Edge middleware cannot consult the async Flags SDK adapter, so auth-entry
  // redirects must use the environment-backed defaults. Keep any manual flag
  // overrides aligned with these env values during rollout.
  const defaultAuthEntryPath = getDefaultAuthEntryPath();

  if (defaultAuthEntryPath === "/") {
    return new URL("/", req.url).toString();
  }

  const authEntryUrl = new URL(defaultAuthEntryPath, req.url);
  authEntryUrl.searchParams.set("redirect_url", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return authEntryUrl.toString();
}

export const proxy = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect({
      unauthenticatedUrl: getUnauthenticatedUrl(req),
    });
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-sdp-pathname", req.nextUrl.pathname);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
