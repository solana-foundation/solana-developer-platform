import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/", "/docs(.*)"]);

function getUnauthenticatedUrl(req: NextRequest): string {
  const authEntryUrl = new URL(AUTH_ENTRY_PATH, req.url);
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
