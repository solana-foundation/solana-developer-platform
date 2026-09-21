import {
  getAccessCredentials,
  hasValidBasicAuthorization,
} from "@server/basic-auth";
import { isLinkPreviewRequest } from "@server/link-preview";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const credentials = getAccessCredentials();
  if (!credentials) {
    return new NextResponse("DEMO_ACCESS_PASSWORD is not configured", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  if (
    isLinkPreviewRequest({
      method: request.method,
      pathname: request.nextUrl.pathname,
      userAgent: request.headers.get("user-agent"),
    })
  ) {
    return NextResponse.next();
  }

  if (
    !hasValidBasicAuthorization(
      request.headers.get("authorization"),
      credentials
    )
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "private, no-store",
        "WWW-Authenticate": 'Basic realm="Northstar Demo", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  // Static assets and the metadata files (favicon, social card, robots) are
  // public so browsers and link unfurlers can fetch them without credentials.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|opengraph-image|twitter-image|robots.txt).*)",
  ],
};
