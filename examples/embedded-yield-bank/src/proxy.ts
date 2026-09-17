import {
  getAccessCredentials,
  hasValidBasicAuthorization,
} from "@server/basic-auth";
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
