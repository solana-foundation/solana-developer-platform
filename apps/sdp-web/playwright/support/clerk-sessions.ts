import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * Where a run records the Clerk sessions it signs in, one empty file per
 * session id, so `auth.global.teardown.ts` can revoke exactly those: a shared
 * test user may have other runs' sessions live at the same time, and those
 * must survive.
 */
const SESSIONS_DIR = path.join(__dirname, "../.clerk/sessions");
const SESSION_ID = /^sess_[A-Za-z0-9]+$/;

/** Longest one revoke request may take before it is abandoned. */
const REVOKE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Longest the whole cleanup may take. The teardown test's own timeout sits
 * above it, so a stalled Clerk can only leave sessions to expire, never fail
 * the run.
 */
export const REVOKE_DEADLINE_MS = 60_000;

/**
 * Records the page's current Clerk session for revocation at the end of the run.
 *
 * @param page - A page Clerk has just signed in.
 * @throws When the page has no Clerk session: every caller has just signed in,
 *   so a missing id means sign-in did not do what the test assumes.
 */
export async function recordClerkSession(page: Page): Promise<void> {
  const sessionId = await page.evaluate(() => {
    const clerk: unknown = Reflect.get(globalThis, "Clerk");
    if (typeof clerk !== "object" || clerk === null) return null;
    const session: unknown = Reflect.get(clerk, "session");
    if (typeof session !== "object" || session === null) return null;
    const id: unknown = Reflect.get(session, "id");
    return typeof id === "string" ? id : null;
  });
  if (!sessionId || !SESSION_ID.test(sessionId)) {
    throw new Error("Cannot record the Clerk session: the signed-in page has no valid session id");
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, sessionId), "");
}

/**
 * Revokes every session this run recorded through the Clerk Backend API, then
 * forgets each one Clerk confirms is gone. Never throws, and stops starting new
 * requests at the deadline; whatever is left is reported and its file kept.
 *
 * @param secretKey - The Clerk instance's secret key.
 * @returns How many sessions were revoked, which failed, and which the deadline skipped.
 */
export async function revokeRecordedClerkSessions(
  secretKey: string
): Promise<{ revoked: number; failed: string[]; skipped: number }> {
  const sessionIds = fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR).filter((name) => SESSION_ID.test(name))
    : [];
  const deadline = Date.now() + REVOKE_DEADLINE_MS;
  let revoked = 0;
  const failed: string[] = [];
  let skipped = 0;
  for (const sessionId of sessionIds) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      skipped += 1;
      continue;
    }
    try {
      const response = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(Math.min(REVOKE_REQUEST_TIMEOUT_MS, remaining)),
      });
      // 404: Clerk no longer has the session, so there is nothing left to revoke.
      if (response.ok || response.status === 404) {
        revoked += 1;
        fs.rmSync(path.join(SESSIONS_DIR, sessionId), { force: true });
      } else {
        failed.push(`${sessionId}: ${response.status}`);
      }
    } catch (error) {
      failed.push(`${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { revoked, failed, skipped };
}
