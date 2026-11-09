import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  API_KEY_FLASH_COOKIE,
  type ApiKeyFlash,
  apiKeyFlashCookieOptions,
} from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-flash";
import { unsealApiKeyFlash } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-flash-seal";
import { requestProjectId } from "@/lib/sdp-api";

async function clearFlashCookie(response: NextResponse) {
  response.cookies.set(
    API_KEY_FLASH_COOKIE,
    "",
    apiKeyFlashCookieOptions(await requestProjectId(), 0)
  );
}

/**
 * One-time delivery of the sealed flash. The cookie is consumed (cleared) on
 * every read attempt, successful or not, and only unseals for the exact
 * Clerk session, user, organization and Project it was minted for. Logout, a different account on
 * the same browser, an expired payload, or a tampered value all yield
 * `{ flash: null }` — never the secret.
 *
 * Consumption is a POST on purpose: a GET with this side effect could be
 * triggered by link prefetching or a forged cross-site navigation, burning
 * the one-time secret before the dashboard reads it. POST is never
 * prefetched, and the strict-SameSite cookie stays home on cross-site
 * requests.
 */
export async function POST() {
  const [{ sessionId, userId, orgId }, jar, projectId] = await Promise.all([
    auth(),
    cookies(),
    requestProjectId(),
  ]);
  const raw = jar.get(API_KEY_FLASH_COOKIE)?.value;

  if (!sessionId || !userId || !orgId) {
    // Not authenticated: destroy any pending secret rather than leave it for
    // whoever signs in on this browser next.
    const response = NextResponse.json({ flash: null }, { status: 401 });
    if (raw) {
      await clearFlashCookie(response);
    }
    return response;
  }

  let flash: ApiKeyFlash | null = null;
  if (raw) {
    flash = await unsealApiKeyFlash(raw, {
      sessionId,
      userId,
      organizationId: orgId,
      projectId,
    });
  }

  const response = NextResponse.json({ flash });
  if (raw) {
    await clearFlashCookie(response);
  }
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  await clearFlashCookie(response);
  return response;
}
