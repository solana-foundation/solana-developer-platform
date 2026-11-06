import { NextResponse } from "next/server";
import { readOrganizationLinked } from "@/lib/sdp-api";
import { getSdpAuth } from "@/lib/sdp-auth";

const BEARER_PREFIX = "Bearer ";

/**
 * Whether this deployment links one of the signed-in person's Clerk organizations.
 * The browser mints a session token for that organization and sends it as the
 * bearer, since the session's own token names only the active one. A GET, not a
 * Server Action: an action runs in the router's queue and can drop a navigation
 * the page makes while it is in flight.
 */
export async function GET(request: Request) {
  const { userId } = await getSdpAuth();
  if (!userId) {
    return NextResponse.json({ error: { message: "Sign-in required" } }, { status: 401 });
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return NextResponse.json(
      { error: { message: "An organization session token is required" } },
      { status: 400 }
    );
  }
  const linked = await readOrganizationLinked(authorization.slice(BEARER_PREFIX.length));
  return NextResponse.json({ linked }, { headers: { "Cache-Control": "no-store" } });
}
